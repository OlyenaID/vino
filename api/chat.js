export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const response = await fetch('https://api.danmurphys.com.au/apis/ui/Search/products', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.danmurphys.com.au',
        'Referer': 'https://www.danmurphys.com.au',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        Filters: [],
        SearchTerm: 'shiraz',
        PageSize: 3,
        PageNumber: 1,
        SortType: 'Relevance',
        Location: 'ListerFacet',
        PageUrl: '/dm/home'
      })
    });

    const data = await response.json();
    const first = data?.Products?.Suggestions?.[0] || {};

    // Return just the fields we care about
    return res.status(200).json({
      Stockcode: first.Stockcode,
      ParentStockcode: first.ParentStockcode,
      Title: first.Title,
      Brand: first.Brand,
      Price: first.Price?.singleprice?.Value,
      AdditionalDetails: first.AdditionalDetails
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
