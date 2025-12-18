// api/markets.js - 完整6类别检测

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        let allMarkets = [];
        let offset = 0;
        
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

        const processed = allMarkets.map(m => {
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
            
            let totalPrice = priceYes + priceNo;
            let spread = 0;
            
            if (m.spread !== undefined && parseFloat(m.spread) > 0) {
                spread = parseFloat(m.spread) * 100;
            } else if (m.bestBid !== undefined && m.bestAsk !== undefined) {
                spread = (parseFloat(m.bestAsk) - parseFloat(m.bestBid)) * 100;
            } else {
                spread = totalPrice - 100;
            }

            return {
                id: m.id || m.conditionId,
                slug: m.slug || '',
                title: m.question || m.title || 'Unknown',
                category: detectCategory(m),
                priceYes: Math.round(priceYes * 10) / 10,
                priceNo: Math.round(priceNo * 10) / 10,
                totalPrice: Math.round(totalPrice * 10) / 10,
                spread: Math.round(spread * 100) / 100,
                liquidity: parseFloat(m.liquidity) || 0,
                volume: parseFloat(m.volume) || 0,
                volume24h: parseFloat(m.volume24hr) || 0,
                endDate: m.endDate || m.endDateIso || null,
                active: !m.closed && m.active !== false,
                closed: m.closed === true
            };
        });

        const valid = processed.filter(m => m.title !== 'Unknown');
        valid.sort((a, b) => b.volume24h - a.volume24h);

        const active = valid.filter(m => m.active);
        const stats = {
            totalMarkets: valid.length,
            activeMarkets: active.length,
            closedMarkets: valid.length - active.length,
            totalVolume: valid.reduce((s, m) => s + m.volume, 0),
            volume24h: valid.reduce((s, m) => s + m.volume24h, 0),
            totalLiquidity: active.reduce((s, m) => s + m.liquidity, 0),
            avgSpread: active.length > 0 ? active.reduce((s, m) => s + Math.abs(m.spread), 0) / active.length : 0,
            catStats: {}
        };

        // 初始化所有7个类别
        ['Politics', 'Crypto', 'Sports', 'Business', 'Science', 'Entertainment', 'Other'].forEach(cat => {
            stats.catStats[cat] = { count: 0, volume: 0, volume24h: 0, liquidity: 0 };
        });

        valid.forEach(m => {
            if (stats.catStats[m.category]) {
                stats.catStats[m.category].count++;
                stats.catStats[m.category].volume += m.volume;
                stats.catStats[m.category].volume24h += m.volume24h;
                stats.catStats[m.category].liquidity += m.liquidity;
            }
        });

        return res.status(200).json({ success: true, count: valid.length, stats, markets: valid });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}

function detectCategory(m) {
    const q = (m.question || '').toLowerCase();
    const t = (m.title || '').toLowerCase();
    const d = (m.description || '').toLowerCase();
    const tags = (m.tags || []).map(tag => (typeof tag === 'string' ? tag : tag.label || '')).join(' ').toLowerCase();
    const g = (m.groupItemTitle || '').toLowerCase();
    const text = `${q} ${t} ${d} ${tags} ${g}`;
    
    // SPORTS - 最具体优先
    if (text.match(/\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bufc\b|\bmma\b|premier league|champions league|la liga|bundesliga|serie a|ligue 1|world cup|euro 202|super bowl|stanley cup|world series|playoffs|finals|championship|mvp|rookie|draft|knicks|lakers|celtics|warriors|bulls|heat|nets|76ers|suns|mavericks|bucks|clippers|cowboys|eagles|chiefs|49ers|bills|ravens|yankees|dodgers|braves|man city|man united|liverpool|chelsea|arsenal|tottenham|real madrid|barcelona|bayern|juventus|psg|tennis|golf|boxing|f1\b|formula 1|nascar|cricket|rugby/)) {
        return 'Sports';
    }
    
    // POLITICS
    if (text.match(/trump|biden|harris|obama|clinton|desantis|newsom|pence|vance|president|election|vote|poll|senate|congress|house of rep|governor|mayor|democrat|republican|gop|politic|impeach|pardon|cabinet|secretary|minister|prime minister|parliament|ukraine|russia|china|israel|gaza|iran|north korea|ceasefire|treaty|white house|capitol|supreme court|scotus|electoral|swing state|midterm|primary/)) {
        return 'Politics';
    }
    
    // CRYPTO
    if (text.match(/bitcoin|btc|\beth\b|ethereum|solana|\bsol\b|\bxrp\b|ripple|doge|dogecoin|cardano|polygon|matic|avalanche|chainlink|polkadot|cosmos|arbitrum|optimism|tether|usdt|usdc|bnb|shiba|pepe|bonk|wif|sui|aptos|celestia|starknet|crypto|defi|nft|token|blockchain|web3|\bdao\b|binance|coinbase|kraken|etf.*bitcoin|bitcoin.*etf|halving|staking|airdrop|altcoin|memecoin|microstrategy/)) {
        return 'Crypto';
    }
    
    // BUSINESS
    if (text.match(/tesla|apple|amazon|google|alphabet|meta|facebook|microsoft|nvidia|amd|intel|netflix|disney|walmart|starbucks|boeing|ford|uber|lyft|airbnb|paypal|visa|jpmorgan|goldman|blackrock|berkshire|palantir|stock|share price|nasdaq|nyse|dow jones|s&p 500|\bspy\b|\bqqq\b|market cap|\bipo\b|earnings|revenue|profit|quarterly|dividend|merger|acquisition|bankrupt|layoff|ceo|cfo|investor|inflation|recession|gdp|federal reserve|\bfed\b|interest rate|rate cut|rate hike|unemployment|treasury|bond|oil price|commodity|economy|economic|corporate/)) {
        return 'Business';
    }
    
    // SCIENCE/TECH
    if (text.match(/\bai\b|artificial intelligence|machine learning|gpt|chatgpt|claude|gemini|llama|llm|neural|deep learning|robot|spacex|starship|falcon|rocket|launch|orbit|mars|moon|nasa|space station|satellite|starlink|neuralink|quantum|semiconductor|chip|processor|medicine|drug|fda|clinical|vaccine|treatment|disease|medical|gene|crispr|biotech|pharmaceutical|\bagi\b|autonomous|self.driving|nuclear|fusion|climate/)) {
        return 'Science';
    }
    
    // ENTERTAINMENT
    if (text.match(/movie|film|cinema|box office|oscar|academy award|golden globe|emmy|grammy|tony|billboard|album|song|artist|singer|band|concert|tour|music|spotify|netflix|disney\+|hbo|streaming|tv show|series|season|episode|actor|actress|director|celebrity|hollywood|taylor swift|beyonce|drake|kanye|kardashian|youtube|tiktok|instagram|influencer|viral|trending|gaming|esports|twitch|playstation|xbox|nintendo|fortnite|minecraft|call of duty|anime|manga|marvel|dc|star wars/)) {
        return 'Entertainment';
    }
    
    return 'Other';
}
