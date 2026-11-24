// ============================================================================
// VINDOX API LAYER (SUPABASE CLIENT, STORAGE, REALTIME & DATA MAPPING)
// ============================================================================
(function () {
  const SUPABASE_URL = 'https://cvfbkxzhpxopbkaymvvf.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_EK07XF7umKLsdfbRK9p6gQ_0-5AkSjb';
  const STORAGE_BUCKET = 'vindox-proofs';

  const sb = (window.supabase && typeof window.supabase.createClient === 'function')
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  if (!sb) {
    console.error('[VindoxAPI] Supabase JS SDK wurde nicht gefunden.');
  }

  function dataUrlToBlob(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return null;
    }
    const parts = dataUrl.split(',');
    if (parts.length < 2) return null;
    const mimeMatch = parts[0].match(/data:(.*?);base64/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const byteString = atob(parts[1]);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mime });
  }

  function extensionFromMime(mime) {
    if (!mime) return 'bin';
    if (mime.includes('png')) return 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('quicktime') || mime.includes('mov')) return 'mov';
    if (mime.includes('webm')) return 'webm';
    return mime.split('/')[1]?.split(';')[0] || 'bin';
  }

  async function uploadAssetIfDataUrl(sourceValue, folderPath, fileBaseName) {
    if (!sourceValue || typeof sourceValue !== 'string') return sourceValue || null;
    if (!sourceValue.startsWith('data:') || !sb) return sourceValue;

    try {
      const blob = dataUrlToBlob(sourceValue);
      if (!blob) return sourceValue;

      const ext = extensionFromMime(blob.type);
      const safeName = `${fileBaseName}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');
      const fullPath = `${folderPath}/${safeName}`;

      const { error: uploadError } = await sb.storage
        .from(STORAGE_BUCKET)
        .upload(fullPath, blob, {
          contentType: blob.type,
          upsert: true
        });

      if (uploadError) {
        console.warn('[VindoxAPI] Storage-Upload Fallback auf Data-URL:', uploadError.message);
        return sourceValue;
      }

      const { data: pubData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(fullPath);
      return pubData?.publicUrl || sourceValue;
    } catch (err) {
      console.warn('[VindoxAPI] Upload-Exception, nutze Fallback:', err);
      return sourceValue;
    }
  }

  function normalizeRules(rules) {
    if (Array.isArray(rules)) {
      return {
        photo: rules.includes('photo'),
        video: rules.includes('video'),
        signature: rules.includes('signature')
      };
    }
    const r = rules || {};
    return {
      photo: Boolean(r.photo),
      video: Boolean(r.video),
      signature: Boolean(r.signature)
    };
  }

  function rulesToArray(rules) {
    const norm = normalizeRules(rules);
    const list = [];
    if (norm.photo) list.push('photo');
    if (norm.video) list.push('video');
    if (norm.signature) list.push('signature');
    return list;
  }

  window.VindoxAPI = {
    client: sb,
    bucket: STORAGE_BUCKET,
    normalizeRules,
    rulesToArray,

    // ------------------------------------------------------------------------
    // DRIVERS & PFLICHTREGELN
    // ------------------------------------------------------------------------
    async upsertDriver(driver) {
      if (!sb || !driver?.id) return { data: null, error: new Error('Ungültige Fahrerdaten') };
      const payload = {
        id: String(driver.id).trim(),
        name: String(driver.name || '').trim(),
        username: String(driver.username || '').trim(),
        password_hash: driver.passwordHash || driver.password_hash || null,
        active: driver.active !== false,
        rules: normalizeRules(driver.rules),
        required_app_version: driver.requiredAppVersion || driver.required_app_version || null
      };
      return await sb.from('drivers').upsert(payload, { onConflict: 'id' }).select().single();
    },

    async fetchDrivers() {
      if (!sb) return [];
      const { data, error } = await sb
        .from('drivers')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) {
        console.error('[VindoxAPI] fetchDrivers error:', error);
        return [];
      }
      return (data || []).map(row => ({
        id: row.id,
        name: row.name,
        username: row.username,
        active: row.active !== false,
        rules: normalizeRules(row.rules),
        requiredAppVersion: row.required_app_version || null
      }));
    },

    async fetchDriverById(driverId) {
      if (!sb || !driverId) return null;
      const { data, error } = await sb
        .from('drivers')
        .select('*')
        .eq('id', String(driverId).trim())
        .maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id,
        name: data.name,
        username: data.username,
        active: data.active !== false,
        rules: normalizeRules(data.rules),
        requiredAppVersion: data.required_app_version || null
      };
    },

    async deleteDriver(driverId) {
      if (!sb || !driverId) return;
      const { error } = await sb.from('drivers').delete().eq('id', String(driverId).trim());
      if (error) console.error('[VindoxAPI] deleteDriver error:', error);
    },

    // ------------------------------------------------------------------------
    // TOURS & STOPS
    // ------------------------------------------------------------------------
    async upsertTour(tour) {
      if (!sb || !tour?.id) return { data: null, error: new Error('Ungültige Tourdaten') };
      const payload = {
        id: String(tour.id).trim(),
        driver_id: String(tour.driverId || tour.driver_id || '').trim(),
        driver_name: String(tour.driverName || tour.driver_name || '').trim(),
        title: String(tour.title || 'Tour').trim(),
        notes: String(tour.notes || '').trim(),
        home_address: String(tour.homeAddress || tour.home_address || '').trim(),
        status: String(tour.status || 'active').trim(),
        stops: Array.isArray(tour.stops) ? tour.stops : []
      };
      return await sb.from('tours').upsert(payload, { onConflict: 'id' }).select().single();
    },

    async fetchTours() {
      if (!sb) return [];
      const { data, error } = await sb
        .from('tours')
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) {
        console.error('[VindoxAPI] fetchTours error:', error);
        return [];
      }
      return (data || []).map(row => ({
        id: row.id,
        driverId: row.driver_id,
        driverName: row.driver_name || '',
        title: row.title,
        notes: row.notes || '',
        homeAddress: row.home_address || '',
        status: row.status || 'active',
        stops: Array.isArray(row.stops) ? row.stops : [],
        updatedAt: row.updated_at
      }));
    },

    async deleteTour(tourId) {
      if (!sb || !tourId) return;
      const { error } = await sb.from('tours').delete().eq('id', String(tourId).trim());
      if (error) console.error('[VindoxAPI] deleteTour error:', error);
    },

    // ------------------------------------------------------------------------
    // DRIVER LIVE (GPS, AKTUELLER STOPP, TELEMETRIE & CHEF-NACHRICHTEN)
    // ------------------------------------------------------------------------
    async upsertDriverLive(liveData) {
      if (!sb || !liveData?.driverId) return;
      const payload = {
        driver_id: String(liveData.driverId).trim(),
        lat: typeof liveData.lat === 'number' && !Number.isNaN(liveData.lat) ? liveData.lat : null,
        lng: typeof liveData.lng === 'number' && !Number.isNaN(liveData.lng) ? liveData.lng : null,
        accuracy_m: typeof liveData.accuracyM === 'number' ? liveData.accuracyM : null,
        heading: typeof liveData.heading === 'number' ? liveData.heading : null,
        speed_kmh: typeof liveData.speedKmh === 'number' ? liveData.speedKmh : null,
        gps_text: String(liveData.gpsText || liveData.gps_text || '').trim(),
        current_stop_index: Number.isFinite(liveData.currentStopIndex) ? liveData.currentStopIndex : 0,
        total_stops: Number.isFinite(liveData.totalStops) ? liveData.totalStops : 0,
        current_stop_title: String(liveData.currentStopTitle || '').trim(),
        current_stop_address: String(liveData.currentStopAddress || '').trim(),
        tour_status: String(liveData.tourStatus || 'driving').trim()
      };
      if (liveData.driverMessage !== undefined) {
        payload.driver_message = String(liveData.driverMessage || '').trim();
        payload.driver_message_at = new Date().toISOString();
      }
      const { error } = await sb.from('driver_live').upsert(payload, { onConflict: 'driver_id' });
      if (error) console.error('[VindoxAPI] upsertDriverLive error:', error);
    },

    async sendChefMessageToDriver(driverId, message) {
      if (!sb || !driverId) return;
      const { error } = await sb.from('driver_live').upsert({
        driver_id: String(driverId).trim(),
        driver_message: String(message || '').trim(),
        driver_message_at: new Date().toISOString()
      }, { onConflict: 'driver_id' });
      if (error) console.error('[VindoxAPI] sendChefMessageToDriver error:', error);
    },

    async fetchDriverLiveList() {
      if (!sb) return [];
      const { data, error } = await sb.from('driver_live').select('*');
      if (error) {
        console.error('[VindoxAPI] fetchDriverLiveList error:', error);
        return [];
      }
      return data || [];
    },

    async fetchDriverLiveById(driverId) {
      if (!sb || !driverId) return null;
      const { data, error } = await sb
        .from('driver_live')
        .select('*')
        .eq('driver_id', String(driverId).trim())
        .maybeSingle();
      if (error) return null;
      return data;
    },

    // ------------------------------------------------------------------------
    // PROOFS & STORAGE UPLOAD
    // ------------------------------------------------------------------------
    async createProof(proof) {
      if (!sb || !proof?.driverId || !proof?.title) {
        return { data: null, error: new Error('Unvollständiger Nachweis') };
      }

      const proofId = proof.id || ('PR-' + Date.now() + '-' + Math.floor(Math.random() * 1000));
      const folder = `${proof.driverId}/${proofId}`;

      const rawMedia = Array.isArray(proof.media) ? proof.media : [];
      const uploadedMedia = [];
      for (let i = 0; i < rawMedia.length; i++) {
        const m = rawMedia[i];
        const uploadedUrl = await uploadAssetIfDataUrl(
          m.url,
          folder,
          `${m.type || 'media'}_${i + 1}_${m.id || Date.now()}`
        );
        uploadedMedia.push({
          ...m,
          url: uploadedUrl
        });
      }

      const uploadedSignature = proof.signature
        ? await uploadAssetIfDataUrl(proof.signature, folder, 'signature')
        : null;

      const row = {
        id: proofId,
        tour_id: proof.tourId || null,
        driver_id: String(proof.driverId).trim(),
        driver_name: String(proof.driverName || '').trim(),
        stop_id: proof.stopId ? String(proof.stopId) : null,
        stop_seq: Number.isFinite(proof.stopSeq) ? proof.stopSeq : 1,
        stop_position_label: String(proof.stopPositionLabel || '').trim(),
        title: String(proof.title).trim(),
        address: String(proof.address || '').trim(),
        gps: String(proof.gps || '').trim(),
        date_label: String(proof.dateLabel || '').trim(),
        time_label: String(proof.timeLabel || '').trim(),
        timestamp_label: String(proof.timestampLabel || '').trim(),
        iso_timestamp: proof.isoTimestamp || new Date().toISOString(),
        media_summary: String(proof.mediaSummary || '').trim(),
        media_capture_times: String(proof.mediaCaptureTimes || '').trim(),
        signature_status: String(proof.signatureStatus || (uploadedSignature ? 'Kundenunterschrift erfasst' : 'Nicht hinterlegt')).trim(),
        audit_hash: String(proof.auditHash || '').trim(),
        media: uploadedMedia,
        signature: uploadedSignature
      };

      return await sb.from('proofs').upsert(row, { onConflict: 'id' }).select().single();
    },

    async fetchProofs() {
      if (!sb) return [];
      const { data, error } = await sb
        .from('proofs')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        console.error('[VindoxAPI] fetchProofs error:', error);
        return [];
      }
      return data || [];
    },

    // ------------------------------------------------------------------------
    // INVOICES (RECHNUNGEN)
    // ------------------------------------------------------------------------
    async upsertInvoice(inv) {
      if (!sb || !inv?.invoiceNumber) return { data: null, error: new Error('Rechnungsnummer fehlt') };
      const net = Number(inv.netAmount ?? inv.net_amount ?? 0);
      const taxRate = Number(inv.taxRate ?? inv.tax_rate ?? 19);
      const taxAmount = Number((net * (taxRate / 100)).toFixed(2));
      const grossAmount = Number((net + taxAmount).toFixed(2));

      const row = {
        id: inv.id || ('INV-' + Date.now()),
        invoice_number: String(inv.invoiceNumber || inv.invoice_number).trim(),
        customer_name: String(inv.customerName || inv.customer_name || 'Kunde').trim(),
        customer_address: String(inv.customerAddress || inv.customer_address || '').trim(),
        description: String(inv.description || '').trim(),
        net_amount: net,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        gross_amount: grossAmount,
        status: String(inv.status || 'draft').trim(),
        linked_proof_ids: Array.isArray(inv.linkedProofIds || inv.linked_proof_ids)
          ? (inv.linkedProofIds || inv.linked_proof_ids)
          : [],
        invoice_date: inv.invoiceDate || inv.invoice_date || new Date().toISOString().slice(0, 10)
      };

      return await sb.from('invoices').upsert(row, { onConflict: 'id' }).select().single();
    },

    async fetchInvoices() {
      if (!sb) return [];
      const { data, error } = await sb
        .from('invoices')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        console.error('[VindoxAPI] fetchInvoices error:', error);
        return [];
      }
      return data || [];
    },

    // ------------------------------------------------------------------------
    // COMPANY SETTINGS (FIRMENDATEN & STANDARDS)
    // ------------------------------------------------------------------------
    async fetchCompanySettings() {
      if (!sb) return null;
      const { data, error } = await sb
        .from('company_settings')
        .select('*')
        .eq('id', 'default')
        .maybeSingle();
      if (error) {
        console.error('[VindoxAPI] fetchCompanySettings error:', error);
        return null;
      }
      return data;
    },

    async saveCompanySettings(settings) {
      if (!sb) return { data: null, error: new Error('Kein Supabase Client') };
      const row = {
        id: 'default',
        company_name: String(settings.companyName ?? settings.company_name ?? 'Vindox Logistik').trim(),
        subtitle: String(settings.subtitle ?? 'Logistik & Dienstleistungen').trim(),
        street: String(settings.street ?? '').trim(),
        city: String(settings.city ?? '').trim(),
        tax_id: String(settings.taxId ?? settings.tax_id ?? '').trim(),
        iban: String(settings.iban ?? '').trim(),
        logo_url: String(settings.logoUrl ?? settings.logo_url ?? '4570730E-A0A2-4546-B316-B15BE9DD5EE4.png').trim(),
        default_home_address: String(settings.defaultHomeAddress ?? settings.default_home_address ?? '').trim(),
        global_required_app_version: String(settings.globalRequiredAppVersion ?? settings.global_required_app_version ?? '1.0.0').trim()
      };
      return await sb.from('company_settings').upsert(row, { onConflict: 'id' }).select().single();
    },

    // ------------------------------------------------------------------------
    // CENTRAL REALTIME SUBSCRIPTION
    // ------------------------------------------------------------------------
    subscribeAll(callback) {
      if (!sb || typeof callback !== 'function') return null;
      const channel = sb.channel('vindox-system-realtime');
      const tables = ['drivers', 'tours', 'driver_live', 'proofs', 'invoices', 'company_settings'];

      tables.forEach((tbl) => {
        channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: tbl },
          (payload) => callback(tbl, payload)
        );
      });

      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[VindoxAPI] Realtime verbunden.');
        }
      });

      return channel;
    }
  };
})();
