// ============================================================================
// VINDOX API LAYER (SUPABASE CLIENT, STORAGE, REALTIME & DATA MAPPING)
// ============================================================================
(function () {
  const SUPABASE_URL = 'https://ejtfhdxoijgzxvkfvuas.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_18oqjMPQ1bmi6IHrLbYjEQ_f75bdVc2';
  const STORAGE_BUCKET = 'vindox-proofs';

  const sb = (window.supabase && typeof window.supabase.createClient === 'function')
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  if (!sb) {
    console.error('[VindoxAPI] Supabase JS SDK wurde nicht gefunden.');
  }

  async function resolveCompanyId(explicitId) {
    if (explicitId) return explicitId;
    if (!sb || !sb.auth) return null;
    const { data } = await sb.auth.getUser();
    return data?.user?.id || null;
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
      if (!sb || !driver?.id) throw new Error('Ungültige Fahrerdaten');
      const cid = await resolveCompanyId(driver.companyId || driver.ownerId);
      const payload = {
        id: String(driver.id).trim(),
        name: String(driver.name || '').trim(),
        vehicle: String(driver.vehicle || '').trim(),
        status: String(driver.status || 'active').trim(),
        username: String(driver.username || '').trim(),
        password_hash: driver.passwordHash || driver.password_hash || null,
        active: driver.active !== false,
        rules: normalizeRules(driver.rules),
        required_app_version: driver.requiredAppVersion || driver.required_app_version || null,
        company_id: cid,
        owner_id: cid
      };
      const { data, error } = await sb.from('drivers').upsert(payload, { onConflict: 'id' }).select().single();
      if (error) throw error;
      return data;
    },

    async updateDriverRules(driverId, rules, explicitCompanyId) {
      if (!sb || !driverId) throw new Error('Fahrer-ID fehlt');
      const cid = await resolveCompanyId(explicitCompanyId);
      const normRules = normalizeRules(rules);
      let query = sb
        .from('drivers')
        .update({ rules: normRules })
        .eq('id', String(driverId).trim());
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query.select().single();
      if (error) throw error;
      return data;
    },

    async fetchDrivers(explicitCompanyId) {
      if (!sb) return [];
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb.from('drivers').select('*').order('created_at', { ascending: true });
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query;
      if (error) {
        console.error('[VindoxAPI] fetchDrivers error:', error);
        throw error;
      }
      return (data || []).map(row => ({
        id: row.id,
        name: row.name,
        vehicle: row.vehicle || '',
        status: row.status || 'active',
        username: row.username || '',
        active: row.active !== false,
        rules: normalizeRules(row.rules),
        requiredAppVersion: row.required_app_version || null,
        companyId: row.company_id
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
        vehicle: data.vehicle || '',
        status: data.status || 'active',
        username: data.username || '',
        active: data.active !== false,
        rules: normalizeRules(data.rules),
        requiredAppVersion: data.required_app_version || null,
        companyId: data.company_id
      };
    },

    async deleteDriver(driverId, explicitCompanyId) {
      if (!sb || !driverId) return;
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb.from('drivers').delete().eq('id', String(driverId).trim());
      if (cid) query = query.eq('company_id', cid);
      const { error } = await query;
      if (error) {
        console.error('[VindoxAPI] deleteDriver error:', error);
        throw error;
      }
    },

    // ------------------------------------------------------------------------
    // TOURS & STOPS
    // ------------------------------------------------------------------------
    async upsertTour(tour) {
      if (!sb || !tour?.id) throw new Error('Ungültige Tourdaten');
      const cid = await resolveCompanyId(tour.companyId || tour.ownerId);
      const payload = {
        id: String(tour.id).trim(),
        driver_id: String(tour.driverId || tour.driver_id || '').trim(),
        driver_name: String(tour.driverName || tour.driver_name || '').trim(),
        title: String(tour.title || 'Tour').trim(),
        notes: String(tour.notes || '').trim(),
        home_address: String(tour.homeAddress || tour.home_address || '').trim(),
        status: String(tour.status || 'active').trim(),
        stops: Array.isArray(tour.stops) ? tour.stops : [],
        company_id: cid,
        owner_id: cid,
        updated_at: new Date().toISOString()
      };
      const { data, error } = await sb.from('tours').upsert(payload, { onConflict: 'id' }).select().single();
      if (error) throw error;
      return data;
    },

    async fetchTours(explicitCompanyId) {
      if (!sb) return [];
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb.from('tours').select('*').order('updated_at', { ascending: false });
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query;
      if (error) {
        console.error('[VindoxAPI] fetchTours error:', error);
        throw error;
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
        updatedAt: row.updated_at,
        companyId: row.company_id
      }));
    },

    async deleteTour(tourId, explicitCompanyId) {
      if (!sb || !tourId) return;
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb.from('tours').delete().eq('id', String(tourId).trim());
      if (cid) query = query.eq('company_id', cid);
      const { error } = await query;
      if (error) {
        console.error('[VindoxAPI] deleteTour error:', error);
        throw error;
      }
    },

    // ------------------------------------------------------------------------
    // DRIVER LIVE (GPS, AKTUELLER STOPP, TELEMETRIE & CHEF-NACHRICHTEN)
    // ------------------------------------------------------------------------
    async upsertDriverLive(liveData) {
      if (!sb || !liveData?.driverId) return;
      const cid = await resolveCompanyId(liveData.companyId || liveData.ownerId);
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
        tour_status: String(liveData.tourStatus || 'driving').trim(),
        company_id: cid,
        owner_id: cid,
        updated_at: new Date().toISOString()
      };
      if (liveData.driverMessage !== undefined) {
        payload.driver_message = String(liveData.driverMessage || '').trim();
        payload.driver_message_at = new Date().toISOString();
      }
      const { error } = await sb.from('driver_live').upsert(payload, { onConflict: 'driver_id' });
      if (error) console.error('[VindoxAPI] upsertDriverLive error:', error);
    },

    async sendDriverMessage(driverId, message, explicitCompanyId) {
      if (!sb || !driverId) throw new Error('Fahrer-ID fehlt');
      const cid = await resolveCompanyId(explicitCompanyId);
      const { error } = await sb.from('driver_live').upsert({
        driver_id: String(driverId).trim(),
        driver_message: String(message || '').trim(),
        driver_message_at: new Date().toISOString(),
        company_id: cid,
        owner_id: cid,
        updated_at: new Date().toISOString()
      }, { onConflict: 'driver_id' });
      if (error) {
        console.error('[VindoxAPI] sendDriverMessage error:', error);
        throw error;
      }
    },

    async sendChefMessageToDriver(driverId, message, explicitCompanyId) {
      return await this.sendDriverMessage(driverId, message, explicitCompanyId);
    },

    async fetchDriverLive(explicitCompanyId) {
      if (!sb) return [];
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb.from('driver_live').select('*');
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query;
      if (error) {
        console.error('[VindoxAPI] fetchDriverLive error:', error);
        throw error;
      }
      return data || [];
    },

    async fetchDriverLiveList(explicitCompanyId) {
      return await this.fetchDriverLive(explicitCompanyId);
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

      const cid = await resolveCompanyId(proof.companyId || proof.ownerId);
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
        signature: uploadedSignature,
        company_id: cid,
        owner_id: cid
      };

      return await sb.from('proofs').upsert(row, { onConflict: 'id' }).select().single();
    },

    async fetchProofs(explicitCompanyId) {
      if (!sb) return [];
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb.from('proofs').select('*').order('created_at', { ascending: false });
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query;
      if (error) {
        console.error('[VindoxAPI] fetchProofs error:', error);
        throw error;
      }
      return (data || []).map(row => ({
        id: row.id,
        tourId: row.tour_id,
        driverId: row.driver_id,
        driverName: row.driver_name || '',
        title: row.title,
        address: row.address || '',
        gps: row.gps || '',
        timestampLabel: row.timestamp_label || '',
        auditHash: row.audit_hash || '',
        media: Array.isArray(row.media) ? row.media : [],
        signature: row.signature || null,
        signatureStatus: row.signature_status || '',
        companyId: row.company_id
      }));
    },

    // ------------------------------------------------------------------------
    // INVOICES (RECHNUNGEN)
    // ------------------------------------------------------------------------
    async upsertInvoice(inv) {
      if (!sb || !(inv?.invoiceNumber || inv?.invoice_number || inv?.id)) {
        throw new Error('Rechnungsnummer fehlt');
      }
      const cid = await resolveCompanyId(inv.companyId || inv.ownerId);
      const invNumber = String(inv.invoiceNumber || inv.invoice_number || inv.id).trim();
      const amountVal = Number(inv.amount ?? inv.grossAmount ?? inv.gross_amount ?? inv.netAmount ?? 0);

      const row = {
        id: String(inv.id || invNumber).trim(),
        invoice_number: invNumber,
        customer: String(inv.customer || inv.customerName || inv.customer_name || 'Kunde').trim(),
        amount: amountVal,
        status: String(inv.status || 'open').trim(),
        due_date: inv.dueDate || inv.due_date || '',
        company_id: cid,
        owner_id: cid
      };

      const { data, error } = await sb.from('invoices').upsert(row, { onConflict: 'id' }).select().single();
      if (error) throw error;
      return data;
    },

    async fetchInvoices(explicitCompanyId) {
      if (!sb) return [];
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb.from('invoices').select('*').order('created_at', { ascending: false });
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query;
      if (error) {
        console.error('[VindoxAPI] fetchInvoices error:', error);
        throw error;
      }
      return (data || []).map(row => ({
        id: row.id,
        invoiceNumber: row.invoice_number || row.id,
        customer: row.customer || row.customer_name || '',
        amount: Number(row.amount ?? row.gross_amount ?? 0),
        status: row.status || 'open',
        dueDate: row.due_date || '',
        companyId: row.company_id
      }));
    },

    async deleteInvoice(invoiceId, explicitCompanyId) {
      if (!sb || !invoiceId) return;
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb.from('invoices').delete().eq('id', String(invoiceId).trim());
      if (cid) query = query.eq('company_id', cid);
      const { error } = await query;
      if (error) {
        console.error('[VindoxAPI] deleteInvoice error:', error);
        throw error;
      }
    },

    // ------------------------------------------------------------------------
    // COMPANY SETTINGS (FIRMENDATEN PRO CHEF)
    // ------------------------------------------------------------------------
    async fetchCompanySettings(explicitCompanyId) {
      if (!sb) return null;
      const cid = await resolveCompanyId(explicitCompanyId);
      if (!cid) return null;
      const { data, error } = await sb
        .from('company_settings')
        .select('*')
        .eq('company_id', cid)
        .maybeSingle();
      if (error) {
        console.error('[VindoxAPI] fetchCompanySettings error:', error);
        throw error;
      }
      if (!data) return null;
      return {
        name: data.name || data.company_name || '',
        owner: data.owner || '',
        street: data.street || '',
        city: data.city || '',
        phone: data.phone || '',
        email: data.email || '',
        taxId: data.tax_id || '',
        companyId: data.company_id
      };
    },

    async saveCompanySettings(settings) {
      if (!sb) throw new Error('Kein Supabase Client');
      const cid = await resolveCompanyId(settings.companyId || settings.ownerId);
      const row = {
        company_id: cid,
        owner_id: cid,
        name: String(settings.name ?? settings.companyName ?? 'Vindox Logistik').trim(),
        owner: String(settings.owner ?? '').trim(),
        street: String(settings.street ?? '').trim(),
        city: String(settings.city ?? '').trim(),
        phone: String(settings.phone ?? '').trim(),
        email: String(settings.email ?? '').trim(),
        tax_id: String(settings.taxId ?? settings.tax_id ?? '').trim(),
        updated_at: new Date().toISOString()
      };
      const { data, error } = await sb
        .from('company_settings')
        .upsert(row, { onConflict: 'company_id' })
        .select()
        .single();
      if (error) throw error;
      return data;
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

      return () => {
        sb.removeChannel(channel);
      };
    }
  };
})();
