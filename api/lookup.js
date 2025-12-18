// api/lookup.js - 获取完整的交易和持仓数据

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { address } = req.query;
    if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/i)) {
        return res.status(400).json({ error: 'Invalid address' });
    }

    const addr = address.toLowerCase();
    
    try {
        // 并行获取所有数据
        const [positions, allHistory, usdcBalance] = await Promise.all([
            fetchAllPositions(addr),
            fetchAllHistory(addr),
            fetchUSDCViaRPC(addr)
        ]);

        // 计算统计
        const historyStats = calcHistoryStats(allHistory);
        const positionStats = calcPositionStats(positions);

        return res.status(200).json({
            success: true,
            address: addr,
            stats: {
                usdcBalance: usdcBalance,
                positionCount: positions.length,
                portfolioValue: positionStats.currentValue,
                investedAmount: positionStats.investedAmount,
                unrealizedPnl: positionStats.unrealizedPnl,
                totalTrades: allHistory.length,
                buyCount: historyStats.buyCount,
                sellCount: historyStats.sellCount,
                totalBuyVolume: historyStats.totalBuyVolume,
                totalSellVolume: historyStats.totalSellVolume,
                totalVolume: historyStats.totalVolume,
                realizedPnl: historyStats.realizedPnl,
                marketsParticipated: historyStats.marketsCount,
                activeDays: historyStats.activeDays,
                firstTradeDate: historyStats.firstDate,
                lastTradeDate: historyStats.lastDate,
                winningPositions: positionStats.winning,
                losingPositions: positionStats.losing,
                winRate: positionStats.winRate
            },
            positions: positions.slice(0, 200), // 显示前200个持仓
            history: allHistory.slice(0, 500)   // 显示前500条交易
        });
    } catch (error) {
        console.error('Lookup error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

// 获取所有持仓 - 分页获取
async function fetchAllPositions(addr) {
    const allPositions = [];
    const seen = new Set();
    
    // 尝试多个API端点
    const endpoints = [
        `https://data-api.polymarket.com/positions?user=${addr}`,
        `https://gamma-api.polymarket.com/positions?user=${addr}`
    ];
    
    for (const baseUrl of endpoints) {
        let offset = 0;
        const limit = 1000;
        
        while (offset < 50000) { // 最多获取5万条
            try {
                const url = `${baseUrl}&limit=${limit}&offset=${offset}`;
                const res = await fetch(url, {
                    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                    timeout: 8000
                });
                
                if (!res.ok) break;
                
                const data = await res.json();
                const items = Array.isArray(data) ? data : (data.positions || data.data || []);
                
                if (items.length === 0) break;
                
                items.forEach(p => {
                    const key = `${p.conditionId||p.marketId||p.id}-${p.outcome||''}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        allPositions.push(p);
                    }
                });
                
                if (items.length < limit) break;
                offset += limit;
            } catch (e) {
                break;
            }
        }
        
        if (allPositions.length > 0) break;
    }
    
    return allPositions;
}

// 获取所有交易历史 - 从多个端点分页获取
async function fetchAllHistory(addr) {
    const allHistory = [];
    const seen = new Set();
    
    // 定义所有需要尝试的API端点
    const endpoints = [
        { base: 'https://data-api.polymarket.com/activity', params: `user=${addr}` },
        { base: 'https://data-api.polymarket.com/trades', params: `user=${addr}` },
        { base: 'https://gamma-api.polymarket.com/trades', params: `maker=${addr}` },
        { base: 'https://gamma-api.polymarket.com/trades', params: `taker=${addr}` },
        { base: 'https://clob.polymarket.com/activity', params: `user=${addr}` }
    ];
    
    // 并行从所有端点获取数据
    const promises = endpoints.map(ep => fetchFromEndpoint(ep.base, ep.params, seen));
    const results = await Promise.all(promises);
    
    results.forEach(items => {
        items.forEach(item => {
            const key = genKey(item);
            if (!seen.has(key)) {
                seen.add(key);
                allHistory.push(processItem(item));
            }
        });
    });
    
    // 按时间排序（最新在前）
    allHistory.sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp));
    
    return allHistory;
}

// 从单个端点分页获取所有数据
async function fetchFromEndpoint(base, params, seen) {
    const items = [];
    let offset = 0;
    const limit = 2000; // 尝试更大的limit
    
    while (offset < 100000) { // 最多10万条
        try {
            const url = `${base}?${params}&limit=${limit}&offset=${offset}`;
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                timeout: 8000
            });
            
            if (!res.ok) break;
            
            const data = await res.json();
            const arr = Array.isArray(data) ? data : (data.trades || data.activity || data.data || []);
            
            if (arr.length === 0) break;
            
            arr.forEach(item => {
                const key = genKey(item);
                if (!seen.has(key)) {
                    items.push(item);
                }
            });
            
            if (arr.length < limit) break;
            offset += limit;
        } catch (e) {
            break;
        }
    }
    
    return items;
}

function genKey(item) {
    return `${item.id||''}-${item.transactionHash||item.txHash||''}-${item.timestamp||item.createdAt||item.time||Math.random()}`;
}

function processItem(item) {
    return {
        id: item.id,
        type: getType(item),
        market: item.title || item.marketSlug || item.market || item.question || item.conditionId || 'Unknown',
        outcome: item.outcome || item.outcomeName || '',
        amount: Math.abs(parseFloat(item.usdcSize) || parseFloat(item.value) || parseFloat(item.amount) || parseFloat(item.size) * (parseFloat(item.price) || 1) || 0),
        price: parseFloat(item.price) || 0,
        profit: parseFloat(item.profit) || parseFloat(item.pnl) || parseFloat(item.realizedPnl) || 0,
        timestamp: item.timestamp || item.createdAt || item.time || item.blockTimestamp
    };
}

function getType(item) {
    const side = (item.side || '').toUpperCase();
    const type = (item.type || '').toLowerCase();
    const action = (item.action || '').toLowerCase();
    
    if (side === 'BUY' || side === 'B') return 'buy';
    if (side === 'SELL' || side === 'S') return 'sell';
    if (type.includes('buy') || type === 'bid') return 'buy';
    if (type.includes('sell') || type === 'ask' || type === 'redeem') return 'sell';
    if (action.includes('buy')) return 'buy';
    if (action.includes('sell') || action === 'redeem') return 'sell';
    if (item.isBuy === true) return 'buy';
    if (item.isBuy === false) return 'sell';
    
    return 'trade';
}

async function fetchUSDCViaRPC(addr) {
    const contracts = ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'];
    const rpcs = ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon', 'https://polygon.llamarpc.com'];
    const padded = '000000000000000000000000' + addr.slice(2);
    const data = '0x70a08231' + padded;
    
    let total = 0;
    
    for (const contract of contracts) {
        for (const rpc of rpcs) {
            try {
                const res = await fetch(rpc, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: contract, data }, 'latest'], id: 1 }),
                    timeout: 5000
                });
                
                if (res.ok) {
                    const json = await res.json();
                    if (json.result && json.result !== '0x' && json.result !== '0x0') {
                        total += parseInt(json.result, 16) / 1e6;
                        break;
                    }
                }
            } catch (e) {}
        }
    }
    
    return total;
}

function parseTS(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000;
    const d = new Date(ts);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

function calcHistoryStats(history) {
    let buyCount = 0, sellCount = 0, totalBuyVolume = 0, totalSellVolume = 0, realizedPnl = 0;
    const markets = new Set(), days = new Set();
    let firstDate = null, lastDate = null;
    
    history.forEach(h => {
        if (h.type === 'buy' || h.type === 'trade') {
            buyCount++;
            totalBuyVolume += h.amount;
        } else if (h.type === 'sell') {
            sellCount++;
            totalSellVolume += h.amount;
            realizedPnl += h.profit || 0;
        }
        
        if (h.market && h.market !== 'Unknown') markets.add(h.market);
        
        const ts = parseTS(h.timestamp);
        if (ts > 0) {
            const d = new Date(ts);
            if (d.getFullYear() >= 2020 && d.getFullYear() <= 2030) {
                days.add(d.toDateString());
                if (!firstDate || ts < parseTS(firstDate)) firstDate = d.toISOString();
                if (!lastDate || ts > parseTS(lastDate)) lastDate = d.toISOString();
            }
        }
    });
    
    return {
        buyCount, sellCount, totalBuyVolume, totalSellVolume,
        totalVolume: totalBuyVolume + totalSellVolume,
        realizedPnl, marketsCount: markets.size, activeDays: days.size,
        firstDate, lastDate
    };
}

function calcPositionStats(positions) {
    let currentValue = 0, investedAmount = 0, winning = 0, losing = 0;
    
    positions.forEach(p => {
        const size = parseFloat(p.size) || parseFloat(p.amount) || parseFloat(p.shares) || 0;
        const price = parseFloat(p.currentPrice) || parseFloat(p.price) || parseFloat(p.outcomePrice) || 0;
        const avgPrice = parseFloat(p.avgPrice) || parseFloat(p.averagePrice) || parseFloat(p.avgCost) || 0;
        
        let curr = parseFloat(p.currentValue) || parseFloat(p.value) || parseFloat(p.marketValue) || 0;
        if (curr === 0 && size > 0) curr = size * price;
        
        let init = parseFloat(p.initialValue) || parseFloat(p.cost) || parseFloat(p.invested) || 0;
        if (init === 0 && size > 0 && avgPrice > 0) init = size * avgPrice;
        
        currentValue += curr;
        investedAmount += init;
        
        const pnl = curr - init;
        if (pnl > 1) winning++;
        else if (pnl < -1) losing++;
    });
    
    const total = winning + losing;
    
    return {
        currentValue, investedAmount,
        unrealizedPnl: currentValue - investedAmount,
        winning, losing,
        winRate: total > 0 ? Math.round(winning / total * 100) : 0
    };
}
