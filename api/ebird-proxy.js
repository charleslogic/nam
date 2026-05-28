export default async function handler(req, res) {
    const { lat, lng, dist, mode, detail, back, maxResults } = req.query;

    const latF = parseFloat(lat);
    const lngF = parseFloat(lng);
    if (isNaN(latF) || isNaN(lngF)) {
        return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const distI   = Math.min(50, Math.max(1, parseInt(dist)       || 15));
    const backI   = Math.min(30, Math.max(1, parseInt(back)       || 14));
    const modeS   = mode   === 'notable' ? 'notable' : 'recent';
    const detailS = detail === 'full'    ? 'full'    : 'simple';

    const key = process.env.EBIRD_API_KEY;
    if (!key) {
        return res.status(500).json({ error: 'Server configuration error' });
    }

    const base = modeS === 'notable' ? 'recent/notable' : 'recent';
    let url = `https://api.ebird.org/v2/data/obs/geo/${base}?lat=${latF}&lng=${lngF}&dist=${distI}&detail=${detailS}&back=${backI}`;
    if (maxResults) {
        const maxI = Math.min(10000, Math.max(1, parseInt(maxResults) || 0));
        if (maxI) url += `&maxResults=${maxI}`;
    }

    try {
        const upstream = await fetch(url, {
            headers: { 'X-eBirdApiToken': key }
        });
        const data = await upstream.text();
        res.status(upstream.status)
           .setHeader('Content-Type', 'application/json')
           .send(data);
    } catch {
        res.status(502).json({ error: 'eBird API unavailable' });
    }
}
