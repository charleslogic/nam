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
        const r = await fetch(`${url}/rest/v1/nam_favorites?select=id,label,loc&order=created_at.desc`, { headers });
        const data = await r.text();
        return res.status(r.status).setHeader('Content-Type', 'application/json').send(data);
    }

    if (req.method === 'POST') {
        const { label, loc } = req.body || {};
        if (!label || !loc) return res.status(400).json({ error: 'label and loc required' });
        const r = await fetch(`${url}/rest/v1/nam_favorites`, {
            method: 'POST',
            headers: { ...headers, 'Prefer': 'return=representation' },
            body: JSON.stringify({ label, loc }),
        });
        const data = await r.text();
        return res.status(r.status).setHeader('Content-Type', 'application/json').send(data);
    }

    if (req.method === 'DELETE') {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id required' });
        const r = await fetch(`${url}/rest/v1/nam_favorites?id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers,
        });
        return res.status(r.ok ? 204 : r.status).end();
    }

    res.status(405).json({ error: 'Method not allowed' });
}
