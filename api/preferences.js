export default async function handler(req, res) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return res.status(500).json({ error: 'Server configuration error' });

    const headers = {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
    };

    if (req.method === 'GET') {
        const prefKey = req.query.key;
        if (!prefKey) return res.status(400).json({ error: 'key required' });
        const r = await fetch(`${url}/rest/v1/nam_prefs?id=eq.${encodeURIComponent(prefKey)}&select=id,value`, { headers });
        const data = await r.json();
        if (!Array.isArray(data) || data.length === 0) return res.status(200).json({});
        return res.status(200).json({ value: data[0].value });
    }

    if (req.method === 'POST') {
        const { key: prefKey, value } = req.body || {};
        if (!prefKey || value === undefined) return res.status(400).json({ error: 'key and value required' });
        const r = await fetch(`${url}/rest/v1/nam_prefs`, {
            method: 'POST',
            headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({ id: prefKey, value }),
        });
        return res.status(r.ok ? 204 : r.status).end();
    }

    res.status(405).json({ error: 'Method not allowed' });
}
