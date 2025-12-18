// api/markets.js - 获取市场数据 + 实时TVL

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // 并行获取市场数据和TVL
        const [markets, tvlData] = await Promise.all([
            fetchAllMarkets(),
            fetchTVL()
        ]);
        
        // 计算统计
        const stats = calcStats(markets);
        stats.tvl = tvlData.tvl;
        stats.tvlChange24h = tvlData.change24h;

        return res.status(200).json({
            success: true,
            markets: markets,
            stats: stats,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('API error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

// 从DefiLlama获取实时TVL
async function fetchTVL() {
    try {
        const res = await fetch('https://api.llama.fi/protocol/polymarket', {
            headers: { 'Accept': 'application/json' }
        });
        if (res.ok) {
            const data = await res.json();
            const tvl = data.currentChainTvls?.Polygon || data.tvl || 0;
            return {
                tvl: tvl > 0 ? tvl : 291790000,
                change24h: data.change_1d || 0
            };
        }
    } catch (e) {}
    return { tvl: 291790000, change24h: 0 };
}

async function fetchAllMarkets() {
    let allMarkets = [];
    let offset = 0;
    
    // 获取活跃市场
    while (offset < 2000) {
        const url = `https://gamma-api.polymarket.com/markets?limit=100&offset=${offset}&closed=false`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) break;
        const data = await r.json();
        if (!Array.isArray(data) || data.length === 0) break;
        allMarkets.push(...data);
        offset += 100;
        if (data.length < 100) break;
    }
    
    // 获取已结束高成交量市场
    offset = 0;
    while (offset < 300) {
        const url = `https://gamma-api.polymarket.com/markets?limit=100&offset=${offset}&closed=true&order=volume&ascending=false`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) break;
        const data = await r.json();
        if (!Array.isArray(data) || data.length === 0) break;
        allMarkets.push(...data);
        offset += 100;
        if (data.length < 100) break;
    }

    return allMarkets.map(processMarket);
}

function processMarket(m) {
    let priceYes = 50, priceNo = 50;
    
    if (m.outcomePrices) {
        try {
            let prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
            if (Array.isArray(prices) && prices.length >= 2) {
                priceYes = parseFloat(prices[0]) * 100;
                priceNo = parseFloat(prices[1]) * 100;
            }
        } catch (e) {}
    }
    
    if ((priceYes === 50 && priceNo === 50) && m.lastTradePrice) {
        priceYes = parseFloat(m.lastTradePrice) * 100;
        priceNo = 100 - priceYes;
    }
    
    let spread = 0;
    if (m.spread !== undefined && parseFloat(m.spread) > 0) {
        spread = parseFloat(m.spread) * 100;
    } else if (m.bestBid !== undefined && m.bestAsk !== undefined) {
        spread = (parseFloat(m.bestAsk) - parseFloat(m.bestBid)) * 100;
    } else {
        spread = (priceYes + priceNo) - 100;
    }

    return {
        id: m.id || m.conditionId,
        slug: m.slug || m.marketSlug || '',
        title: m.question || m.title || 'Unknown',
        category: detectCategory(m),
        active: m.closed !== true && m.active !== false,
        priceYes: Math.round(priceYes * 100) / 100,
        priceNo: Math.round(priceNo * 100) / 100,
        totalPrice: Math.round((priceYes + priceNo) * 100) / 100,
        spread: Math.round(spread * 100) / 100,
        liquidity: parseFloat(m.liquidity) || 0,
        volume: parseFloat(m.volume) || parseFloat(m.volumeNum) || 0,
        volume24h: parseFloat(m.volume24hr) || parseFloat(m.volume24h) || 0,
        endDate: m.endDate || m.endDateIso || m.resolutionDate || null
    };
}

function detectCategory(m) {
    const text = ((m.question || '') + ' ' + (m.title || '') + ' ' + (m.description || '') + ' ' + (m.tags || [])).toLowerCase();
    
    if (/trump|biden|harris|election|vote|president|congress|senate|governor|democrat|republican|political|government|legislation|poll|primary|gop|dnc/.test(text)) return 'Politics';
    if (/bitcoin|btc|ethereum|eth|crypto|token|defi|nft|blockchain|solana|sol|doge|coin|binance|coinbase|web3|altcoin/.test(text)) return 'Crypto';
    if (/nfl|nba|mlb|nhl|soccer|football|basketball|tennis|golf|olympics|championship|world cup|super bowl|playoffs|game|match|team|player|sport|ufc|boxing|f1|racing/.test(text)) return 'Sports';
    if (/stock|market|fed|interest rate|inflation|gdp|economy|earnings|ipo|nasdaq|dow|s&p|company|ceo|merger|acquisition|revenue|profit|business|trade|tariff/.test(text)) return 'Business';
    if (/movie|film|tv|show|oscar|emmy|grammy|music|album|actor|actress|celebrity|entertainment|netflix|disney|streaming|box office|award|concert/.test(text)) return 'Entertainment';
    if (/ai|artificial intelligence|science|research|space|nasa|climate|weather|health|medical|vaccine|fda|study|discovery|technology|tech/.test(text)) return 'Science';
    return 'Other';
}

function calcStats(markets) {
    const cats = {};
    ['Politics','Crypto','Sports','Business','Science','Entertainment','Other'].forEach(c => {
        cats[c] = { count: 0, volume: 0, liquidity: 0 };
    });
    
    let totalVol = 0, totalLiq = 0, activeCount = 0;
    
    markets.forEach(m => {
        const cat = m.category;
        if (cats[cat]) {
            cats[cat].count++;
            cats[cat].volume += m.volume;
            cats[cat].liquidity += m.liquidity;
        }
        totalVol += m.volume;
        totalLiq += m.liquidity;
        if (m.active) activeCount++;
    });

    return {
        totalMarkets: markets.length,
        activeMarkets: activeCount,
        totalVolume: totalVol,
        totalLiquidity: totalLiq,
        catStats: cats
    };
}
