export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, system, shopUrl, shopName } = req.body;
  if (!messages || !system) return res.status(400).json({ error: 'Missing messages or system prompt' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured on server' });

  try {
    const userMessage = messages[messages.length - 1]?.content || '';
    const searchTerms = await extractSearchTerms(userMessage, apiKey);

    let products = [];
    let searchNote = '';

    if (searchTerms) {
      const isDanMurphys = shopUrl && shopUrl.includes('danmurphys.com.au');
      const isBWS = shopUrl && shopUrl.includes('bws.com.au');

      if (isDanMurphys || isBWS) {
        const result = await searchEndeavourGroup(shopUrl, searchTerms);
        products = result.products;
        searchNote = result.note;
      } else {
        const result = await searchGeneric(shopUrl, searchTerms);
        products = result.products;
        searchNote = result.note;
      }
    }

    const enrichedSystem = products.length > 0
      ? `${system}\n\nLIVE SEARCH RESULTS from ${shopName} for "${searchTerms}":\n${JSON.stringify(products, null, 2)}\n\nREQUIRED: Only recommend wines from this live search results list. Use the exact name, price and URL provided. Do not invent wines.`
      : `${system}\n\nNote: Could not fetch live results from ${shopName} (${searchNote}). Recommend wines commonly stocked there and use URL: ${shopUrl}/search?q=WINE+NAME`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: enrichedSystem,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

async function extractSearchTerms(message, apiKey) {
  const lowerMsg = message.toLowerCase();
  const signals = ['wine','red','white','rose','sparkling','shiraz','pinot','cab',
    'chardonnay','recommend','suggest','bottle','something','looking','dinner','gift',
    'occasion','lamb','chicken','pasta','steak','fish','budget','under','cheap',
    'value','special','celebrate'];
  if (!signals.some(s => lowerMsg.includes(s))) return null;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 50,
        system: 'Extract 1-3 wine search keywords from the user message. Return ONLY the search term, nothing else. Examples: "shiraz", "pinot noir", "sparkling wine". If no specific wine type is mentioned, return the most relevant general term like "red wine" or "white wine".',
        messages: [{ role: 'user', content: message }]
      })
    });
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || 'wine';
  } catch { return 'wine'; }
}

async function searchEndeavourGroup(shopUrl, searchTerms) {
  const isDanMurphys = shopUrl.includes('danmurphys');
  const apiBase = isDanMurphys
    ? 'https://api.danmurphys.com.au/apis/ui/Search/products'
    : 'https://api.bws.com.au/apis/ui/Search/products';

  try {
    const response = await fetch(apiBase, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': shopUrl,
        'Referer': shopUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        Filters: [],
        SearchTerm: searchTerms,
        PageSize: 10,
        PageNumber: 1,
        SortType: 'Relevance',
        Location: 'ListerFacet',
        PageUrl: '/dm/home'
      })
    });

    if (!response.ok) throw new Error('API returned ' + response.status);
    const data = await response.json();
    const suggestions = data?.Products?.Suggestions || [];

    const products = suggestions.slice(0, 8).map(p => {
      const details = Object.fromEntries((p.AdditionalDetails || []).map(d => [d.Name, d.Value]));

      // Build direct product URL from dm_stockcode (e.g. "DM_144469")
      const dmCode = details.dm_stockcode || '';
      const rawCode = p.Stockcode || p.ParentStockcode || '';
      let url;
      if (dmCode) {
        url = isDanMurphys
          ? 'https://www.danmurphys.com.au/product/' + dmCode
          : 'https://bws.com.au/product/' + dmCode;
      } else if (rawCode) {
        url = isDanMurphys
          ? 'https://www.danmurphys.com.au/product/DM_' + rawCode
          : 'https://bws.com.au/product/BWS_' + rawCode;
      } else {
        url = isDanMurphys
          ? 'https://www.danmurphys.com.au/search?q=' + encodeURIComponent(p.Title || '')
          : 'https://bws.com.au/search?q=' + encodeURIComponent(p.Title || '');
      }

      return {
        name: p.Title || details.webproductname || 'Unknown',
        brand: p.Brand || '',
        price: p.Price?.singleprice?.Value || 0,
        region: details.webregionoforigin || '',
        varietal: details.varietal || '',
        body: details.webwinebody || '',
        style: details.webwinestyle || '',
        foodMatch: details.webfoodmatch || '',
        description: (details.webdescriptionshort || '').substring(0, 150),
        rating: details.webaverageproductrating || '',
        vintage: details.webvintagecurrent || '',
        url
      };
    });

    return { products, note: 'Found ' + products.length + ' results' };
  } catch (err) {
    return { products: [], note: 'Endeavour API error: ' + err.message };
  }
}

async function searchGeneric(shopUrl, searchTerms) {
  try {
    const base = shopUrl.replace(/\/$/, '');
    const encoded = encodeURIComponent(searchTerms);
    const isShopify = shopUrl.includes('blackheartsandsparrows') || shopUrl.includes('sometimesalways');
    const searchUrl = isShopify
      ? base + '/search/suggest.json?q=' + encoded + '&resources[type]=product&resources[limit]=8'
      : base + '/search?q=' + encoded + '&type=product';

    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json',
        'Accept-Language': 'en-AU,en;q=0.9'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error('HTTP ' + response.status);

    if (isShopify) {
      const data = await response.json();
      const items = data?.resources?.results?.products || [];
      const products = items.slice(0, 8).map(p => ({
        name: p.title,
        price: p.price ? parseInt(p.price) / 100 : 0,
        url: base + p.url,
        description: p.body || ''
      }));
      return { products, note: 'Found ' + products.length + ' results' };
    }

    return { products: [], note: 'HTML fetch — using general knowledge' };
  } catch (err) {
    return { products: [], note: 'Fetch error: ' + err.message };
  }
}
