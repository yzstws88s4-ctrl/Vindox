// ============================================================================
// VINDOX API LAYER (SUPABASE CLIENT, STORAGE, REALTIME & DATA MAPPING)
// ============================================================================
(function () {
  const SUPABASE_URL = 'https://ejtfhdxoijgzxvkfvuas.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_18oqjMPQ1bmi6IHrLbYjEQ_f75bdVc2';
  const STORAGE_BUCKET = 'vindox-proofs';
  const SHARED_KEY_STORAGE = 'vindox_chef_shared_openai_key';
  const DRIVER_KEY_STORAGE = 'vindox_openai_key';

  const sb = (window.supabase && typeof window.supabase.createClient === 'function')
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  if (!sb) {
    console.error('[VindoxAPI] Supabase JS SDK wurde nicht gefunden.');
  }

  let runtimeSharedOpenAiKey = '';

  function formatErrorMessage(err, fallback = 'Unbekannter Datenbankfehler') {
    if (!err) return fallback;
    if (typeof err === 'string') return err;
    const parts = [err.message, err.details, err.hint].filter(Boolean);
    return parts.length > 0 ? parts.join(' — ') : fallback;
  }

  function escapeFilterValue(val) {
    return String(val || '').replace(/[%_,()]/g, '').trim();
  }

  function normalizeApiKey(rawKey) {
    const clean = String(rawKey || '').trim();
    return clean || '';
  }

  function getStoredSharedOpenAiKey() {
    if (runtimeSharedOpenAiKey) return runtimeSharedOpenAiKey;
    try {
      const fromChef = localStorage.getItem(SHARED_KEY_STORAGE);
      if (fromChef && fromChef.trim()) {
        runtimeSharedOpenAiKey = fromChef.trim();
        return runtimeSharedOpenAiKey;
      }
      const fromDriverCache = localStorage.getItem(DRIVER_KEY_STORAGE);
      if (fromDriverCache && fromDriverCache.trim()) {
        runtimeSharedOpenAiKey = fromDriverCache.trim();
        return runtimeSharedOpenAiKey;
      }
    } catch (_e) {}
    return '';
  }

  function setSharedOpenAiKey(rawKey, options = {}) {
    const clean = normalizeApiKey(rawKey);
    runtimeSharedOpenAiKey = clean;
    try {
      if (clean) {
        localStorage.setItem(SHARED_KEY_STORAGE, clean);
        if (options.applyToCurrentDriver !== false) {
          localStorage.setItem(DRIVER_KEY_STORAGE, clean);
        }
      } else if (options.clear === true) {
        localStorage.removeItem(SHARED_KEY_STORAGE);
      }
    } catch (_e) {}
    return clean;
  }

  function applyOpenAiKeyToDriverEnvironment(apiKey) {
    const clean = normalizeApiKey(apiKey) || getStoredSharedOpenAiKey();
    if (!clean) return '';
    runtimeSharedOpenAiKey = clean;
    try {
      localStorage.setItem(DRIVER_KEY_STORAGE, clean);
      localStorage.setItem(SHARED_KEY_STORAGE, clean);
    } catch (_e) {}
    return clean;
  }

  async function resolveCompanyId(explicitId) {
    if (explicitId) return String(explicitId).trim();
    if (!sb || !sb.auth) return null;
    try {
      const { data, error } = await sb.auth.getUser();
      if (!error && data?.user?.id) return data.user.id;
      const { data: sessData } = await sb.auth.getSession();
      return sessData?.session?.user?.id || null;
    } catch (_e) {
      return null;
    }
  }

  function attachOwnerIds(payload, explicitId) {
    if (!explicitId) return payload;
    const cleanId = String(explicitId).trim();
    if (!cleanId) return payload;
    return {
      ...payload,
      company_id: cleanId,
      owner_id: cleanId
    };
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

  function extractKeyFromRowRules(row) {
    if (!row) return '';
    if (row.openai_api_key) return normalizeApiKey(row.openai_api_key);
    if (row.rules && typeof row.rules === 'object' && !Array.isArray(row.rules)) {
      if (row.rules.openaiApiKey) return normalizeApiKey(row.rules.openaiApiKey);
      if (row.rules.openai_api_key) return normalizeApiKey(row.rules.openai_api_key);
    }
    return '';
  }

  function mapDriverRow(row) {
    if (!row) return null;
    const rowKey = extractKeyFromRowRules(row);
    const effectiveKey = rowKey || getStoredSharedOpenAiKey();
    return {
      id: row.id,
      name: row.name || '',
      vehicle: row.vehicle || '',
      status: row.status || 'active',
      username: row.username || '',
      password_hash: row.password_hash || '',
      passwordHash: row.password_hash || '',
      active: row.active !== false,
      rules: normalizeRules(row.rules),
      openaiApiKey: effectiveKey,
      requiredAppVersion: row.required_app_version || null,
      companyId: row.company_id || row.owner_id || null,
      ownerId: row.owner_id || row.company_id || null
    };
  }

  async function broadcastOpenAiKeyToDriver(driverId, apiKey, explicitCompanyId) {
    const cleanKey = normalizeApiKey(apiKey) || getStoredSharedOpenAiKey();
    if (!sb || !driverId || !cleanKey) return false;
    const cid = await resolveCompanyId(explicitCompanyId);
    const cleanDriverId = String(driverId).trim();

    let payload = {
      driver_id: cleanDriverId,
      openai_api_key: cleanKey,
      updated_at: new Date().toISOString()
    };
    payload = attachOwnerIds(payload, cid);

    const { error } = await sb
      .from('driver_live')
      .upsert(payload, { onConflict: 'driver_id' });

    if (error) {
      console.warn('[VindoxAPI] Konnte API-Key nicht in driver_live hinterlegen:', error.message);
      return false;
    }
    return true;
  }

  window.VindoxAPI = {
    client: sb,
    bucket: STORAGE_BUCKET,
    normalizeRules,
    rulesToArray,
    formatErrorMessage,
    resolveCompanyId,
    setSharedOpenAiKey,
    getSharedOpenAiKey: getStoredSharedOpenAiKey,
    applyOpenAiKeyToDriverEnvironment,
    broadcastOpenAiKeyToDriver,

    // ------------------------------------------------------------------------
    // DRIVERS & PFLICHTREGELN (+ AUTOMATISCHER API-KEY-TRANSFER)
    // ------------------------------------------------------------------------
    async upsertDriver(driver) {
      if (!sb) throw new Error('Supabase-Client nicht initialisiert');
      const driverId = String(driver?.id || '').trim();
      const driverName = String(driver?.name || '').trim();
      if (!driverId || !driverName) {
        throw new Error('Fahrer-ID und Name sind erforderlich');
      }

      const cid = await resolveCompanyId(driver.companyId || driver.ownerId);
      const statusVal = String(driver.status || 'active').trim();
      const passwordVal = (driver.passwordHash !== undefined ? driver.passwordHash : driver.password_hash);
      const cleanPassword = passwordVal === null || passwordVal === undefined
        ? null
        : String(passwordVal).trim() || null;

      const sharedKey = normalizeApiKey(
        driver.openaiApiKey || driver.openai_api_key || getStoredSharedOpenAiKey()
      );
      if (sharedKey) {
        setSharedOpenAiKey(sharedKey, { applyToCurrentDriver: false });
      }

      const baseRules = normalizeRules(driver.rules);
      const rulesPayload = sharedKey
        ? { ...baseRules, openai_api_key: sharedKey }
        : baseRules;

      let payload = {
        id: driverId,
        name: driverName,
        vehicle: String(driver.vehicle || '').trim(),
        status: statusVal,
        username: String(driver.username || driverId).trim(),
        password_hash: cleanPassword,
        active: driver.active !== false && statusVal !== 'offline',
        rules: rulesPayload,
        required_app_version: driver.requiredAppVersion || driver.required_app_version || null
      };
      payload = attachOwnerIds(payload, cid);

      const { data, error } = await sb
        .from('drivers')
        .upsert(payload, { onConflict: 'id' })
        .select()
        .single();

      if (error) {
        console.error('[VindoxAPI] upsertDriver error:', error);
        throw new Error(formatErrorMessage(error, 'Fahrer konnte nicht in drivers gespeichert werden'));
      }

      let livePayload = {
        driver_id: driverId,
        tour_status: statusVal === 'offline' ? 'offline' : 'ready',
        updated_at: new Date().toISOString()
      };
      if (sharedKey) {
        livePayload.openai_api_key = sharedKey;
      }
      livePayload = attachOwnerIds(livePayload, cid);

      const { error: liveError } = await sb
        .from('driver_live')
        .upsert(livePayload, { onConflict: 'driver_id' });

      if (liveError) {
        console.warn('[VindoxAPI] driver_live Initial-Sync Warnung:', liveError.message);
      }

      return mapDriverRow(data);
    },

    async loginDriver(driverId, password) {
      if (!sb) throw new Error('Supabase-Client nicht initialisiert');
      const cleanLogin = String(driverId || '').trim();
      const cleanPw = String(password || '').trim();
      if (!cleanLogin || !cleanPw) {
        throw new Error('Bitte Fahrer-ID und Passwort eingeben');
      }

      const safeFilterVal = escapeFilterValue(cleanLogin);
      const needle = cleanLogin.toLowerCase();

      let { data: rows, error } = await sb
        .from('drivers')
        .select('*')
        .or(`id.ilike.${safeFilterVal},username.ilike.${safeFilterVal}`)
        .limit(10);

      if ((!rows || rows.length === 0) && !error) {
        const fallback = await sb
          .from('drivers')
          .select('*')
          .limit(200);
        error = fallback.error;
        rows = Array.isArray(fallback.data) ? fallback.data : [];
      }

      if (error) {
        console.error('[VindoxAPI] loginDriver query error:', error);
        throw new Error(formatErrorMessage(error, 'Fahrer-Login fehlgeschlagen'));
      }

      const list = Array.isArray(rows) ? rows : [];
      const match =
        list.find(r => String(r.id || '').trim().toLowerCase() === needle) ||
        list.find(r => String(r.username || '').trim().toLowerCase() === needle) ||
        null;

      if (!match) {
        throw new Error('Fahrer-ID nicht gefunden');
      }
      if (match.active === false) {
        throw new Error('Dieser Fahrerzugang ist deaktiviert');
      }

      const storedPw = String(match.password_hash ?? '').trim();
      if (!storedPw || storedPw !== cleanPw) {
        throw new Error('Ungültiges Passwort');
      }

      const mapped = mapDriverRow(match);
      let keyToApply = extractKeyFromRowRules(match);

      if (!keyToApply && match.id) {
        try {
          const { data: liveRow } = await sb
            .from('driver_live')
            .select('openai_api_key')
            .eq('driver_id', match.id)
            .maybeSingle();
          if (liveRow && liveRow.openai_api_key) {
            keyToApply = normalizeApiKey(liveRow.openai_api_key);
          }
        } catch (_e) {}
      }

      if (!keyToApply) {
        keyToApply = getStoredSharedOpenAiKey();
      }

      if (keyToApply) {
        applyOpenAiKeyToDriverEnvironment(keyToApply);
        mapped.openaiApiKey = keyToApply;
      }

      return mapped;
    },

    async updateDriverRules(driverId, rules, explicitCompanyId) {
      if (!sb || !driverId) throw new Error('Fahrer-ID fehlt');
      const cid = await resolveCompanyId(explicitCompanyId);
      const normRules = normalizeRules(rules);
      const sharedKey = getStoredSharedOpenAiKey();
      const rulesToSave = sharedKey
        ? { ...normRules, openai_api_key: sharedKey }
        : normRules;

      let query = sb
        .from('drivers')
        .update({ rules: rulesToSave })
        .eq('id', String(driverId).trim());
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query.select().single();
      if (error) {
        throw new Error(formatErrorMessage(error, 'Pflichtnachweise konnten nicht gespeichert werden'));
      }
      if (sharedKey) {
        await broadcastOpenAiKeyToDriver(driverId, sharedKey, cid);
      }
      return mapDriverRow(data);
    },

    async fetchDrivers(explicitCompanyId) {
      if (!sb) return [];
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb.from('drivers').select('*').order('created_at', { ascending: true });
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query;
      if (error) {
        console.error('[VindoxAPI] fetchDrivers error:', error);
        throw new Error(formatErrorMessage(error, 'Fahrer konnten nicht geladen werden'));
      }
      return (data || []).map(mapDriverRow);
    },

    async fetchDriverById(driverId, explicitCompanyId) {
      if (!sb || !driverId) return null;
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb
        .from('drivers')
        .select('*')
        .eq('id', String(driverId).trim());
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query.maybeSingle();
      if (error || !data) return null;
      const mapped = mapDriverRow(data);
      if (mapped.openaiApiKey) {
        applyOpenAiKeyToDriverEnvironment(mapped.openaiApiKey);
      }
      return mapped;
    },

    async deleteDriver(driverId, explicitCompanyId) {
      if (!sb || !driverId) return;
      const cid = await resolveCompanyId(explicitCompanyId);
      const cleanId = String(driverId).trim();

      let liveQuery = sb.from('driver_live').delete().eq('driver_id', cleanId);
      if (cid) liveQuery = liveQuery.eq('company_id', cid);
      await liveQuery;

      let query = sb.from('drivers').delete().eq('id', cleanId);
      if (cid) query = query.eq('company_id', cid);
      const { error } = await query;
      if (error) {
        console.error('[VindoxAPI] deleteDriver error:', error);
        throw new Error(formatErrorMessage(error, 'Fahrer konnte nicht gelöscht werden'));
      }
    },

    // ------------------------------------------------------------------------
    // TOURS & STOPS (+ AUTOMATISCHE KEY-ÜBERMITTLUNG AN FAHRER)
    // ------------------------------------------------------------------------
    async upsertTour(tour) {
      if (!sb || !tour?.id) throw new Error('Ungültige Tourdaten');
      const cid = await resolveCompanyId(tour.companyId || tour.ownerId || tour.company_id || tour.owner_id);
      const driverId = String(tour.driverId || tour.driver_id || '').trim();
      const sharedKey = normalizeApiKey(
        tour.openaiApiKey || tour.openai_api_key || getStoredSharedOpenAiKey()
      );
      if (sharedKey) {
        setSharedOpenAiKey(sharedKey, { applyToCurrentDriver: false });
      }

      let payload = {
        id: String(tour.id).trim(),
        driver_id: driverId,
        driver_name: String(tour.driverName || tour.driver_name || '').trim(),
        title: String(tour.title || 'Tour').trim(),
        notes: String(tour.notes || '').trim(),
        home_address: String(tour.homeAddress || tour.home_address || '').trim(),
        status: String(tour.status || 'active').trim(),
        stops: Array.isArray(tour.stops) ? tour.stops : [],
        updated_at: new Date().toISOString()
      };
      payload = attachOwnerIds(payload, cid);

      const { data, error } = await sb.from('tours').upsert(payload, { onConflict: 'id' }).select().single();
      if (error) {
        console.error('[VindoxAPI] upsertTour error:', error);
        throw new Error(formatErrorMessage(error, 'Tour konnte nicht gespeichert werden'));
      }

      if (driverId && sharedKey) {
        await broadcastOpenAiKeyToDriver(driverId, sharedKey, cid);
      }

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
        throw new Error(formatErrorMessage(error, 'Touren konnten nicht geladen werden'));
      }
      const sharedKey = getStoredSharedOpenAiKey();
      if (sharedKey) {
        applyOpenAiKeyToDriverEnvironment(sharedKey);
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
        openaiApiKey: sharedKey || '',
        updatedAt: row.updated_at,
        companyId: row.company_id || row.owner_id || null
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
        throw new Error(formatErrorMessage(error, 'Tour konnte nicht gelöscht werden'));
      }
    },

    // ------------------------------------------------------------------------
    // DRIVER LIVE (GPS, AKTUELLER STOPP, TELEMETRIE & CHEF-NACHRICHTEN)
    // ------------------------------------------------------------------------
    async upsertDriverLive(liveData) {
      if (!sb || !liveData?.driverId) return;
      const cid = await resolveCompanyId(liveData.companyId || liveData.ownerId || liveData.company_id || liveData.owner_id);
      const sharedKey = getStoredSharedOpenAiKey();
      let payload = {
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
        updated_at: new Date().toISOString()
      };
      if (sharedKey) {
        payload.openai_api_key = sharedKey;
      }
      payload = attachOwnerIds(payload, cid);

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
      const sharedKey = getStoredSharedOpenAiKey();
      let payload = {
        driver_id: String(driverId).trim(),
        driver_message: String(message || '').trim(),
        driver_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (sharedKey) {
        payload.openai_api_key = sharedKey;
      }
      payload = attachOwnerIds(payload, cid);

      const { error } = await sb.from('driver_live').upsert(payload, { onConflict: 'driver_id' });
      if (error) {
        console.error('[VindoxAPI] sendDriverMessage error:', error);
        throw new Error(formatErrorMessage(error, 'Nachricht konnte nicht gesendet werden'));
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
        throw new Error(formatErrorMessage(error, 'Live-Daten konnten nicht geladen werden'));
      }
      const list = data || [];
      list.forEach((row) => {
        if (row && row.openai_api_key) {
          applyOpenAiKeyToDriverEnvironment(row.openai_api_key);
        }
      });
      return list;
    },

    async fetchDriverLiveList(explicitCompanyId) {
      return await this.fetchDriverLive(explicitCompanyId);
    },

    async fetchDriverLiveById(driverId, explicitCompanyId) {
      if (!sb || !driverId) return null;
      const cid = await resolveCompanyId(explicitCompanyId);
      let query = sb
        .from('driver_live')
        .select('*')
        .eq('driver_id', String(driverId).trim());
      if (cid) query = query.eq('company_id', cid);
      const { data, error } = await query.maybeSingle();
      if (error) return null;
      if (data && data.openai_api_key) {
        applyOpenAiKeyToDriverEnvironment(data.openai_api_key);
      }
      return data;
    },

    // ------------------------------------------------------------------------
    // PROOFS & STORAGE UPLOAD
    // ------------------------------------------------------------------------
    async createProof(proof) {
      if (!sb || !proof?.driverId || !proof?.title) {
        return { data: null, error: new Error('Unvollständiger Nachweis') };
      }

      const cid = await resolveCompanyId(proof.companyId || proof.ownerId || proof.company_id || proof.owner_id);
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

      let row = {
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
      row = attachOwnerIds(row, cid);

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
        throw new Error(formatErrorMessage(error, 'Nachweise konnten nicht geladen werden'));
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
        companyId: row.company_id || row.owner_id || null
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

      let row = {
        id: String(inv.id || invNumber).trim(),
        invoice_number: invNumber,
        customer: String(inv.customer || inv.customerName || inv.customer_name || 'Kunde').trim(),
        amount: amountVal,
        status: String(inv.status || 'open').trim(),
        due_date: inv.dueDate || inv.due_date || ''
      };
      row = attachOwnerIds(row, cid);

      const { data, error } = await sb.from('invoices').upsert(row, { onConflict: 'id' }).select().single();
      if (error) {
        throw new Error(formatErrorMessage(error, 'Rechnung konnte nicht gespeichert werden'));
      }
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
        throw new Error(formatErrorMessage(error, 'Rechnungen konnten nicht geladen werden'));
      }
      return (data || []).map(row => ({
        id: row.id,
        invoiceNumber: row.invoice_number || row.id,
        customer: row.customer || row.customer_name || '',
        amount: Number(row.amount ?? row.gross_amount ?? 0),
        status: row.status || 'open',
        dueDate: row.due_date || '',
        companyId: row.company_id || row.owner_id || null
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
        throw new Error(formatErrorMessage(error, 'Rechnung konnte nicht gelöscht werden'));
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
        throw new Error(formatErrorMessage(error, 'Firmendaten konnten nicht geladen werden'));
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
        companyId: data.company_id || data.owner_id || null
      };
    },

    async saveCompanySettings(settings) {
      if (!sb) throw new Error('Kein Supabase Client');
      const cid = await resolveCompanyId(settings.companyId || settings.ownerId);
      let row = {
        name: String(settings.name ?? settings.companyName ?? 'Vindox Logistik').trim(),
        owner: String(settings.owner ?? '').trim(),
        street: String(settings.street ?? '').trim(),
        city: String(settings.city ?? '').trim(),
        phone: String(settings.phone ?? '').trim(),
        email: String(settings.email ?? '').trim(),
        tax_id: String(settings.taxId ?? settings.tax_id ?? '').trim(),
        updated_at: new Date().toISOString()
      };
      row = attachOwnerIds(row, cid);

      const { data, error } = await sb
        .from('company_settings')
        .upsert(row, { onConflict: 'company_id' })
        .select()
        .single();
      if (error) {
        throw new Error(formatErrorMessage(error, 'Firmendaten konnten nicht gespeichert werden'));
      }
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
