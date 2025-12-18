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
            fetchAllTrades(addr),
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
            positions: positions.slice(0, 200),
            history: allHistory.slice(0, 500)
        });
    } catch (error) {
        console.error('Lookup error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

// 获取所有持仓
async function fetchAllPositions(addr) {
    const allPositions = [];
    const seen = new Set();
    
    // 使用多个API端点并行获取
    const results = await Promise.all([
        paginate(`https://data-api.polymarket.com/positions?user=${addr}`, 1000, 50000),
        paginate(`https://gamma-api.polymarket.com/positions?user=${addr}`, 500, 20000)
    ]);
    
    results.flat().forEach(p => {
        const key = `${p.conditionId||p.marketId||p.id}-${p.outcome||''}`;
        if (!seen.has(key)) {
            seen.add(key);
            allPositions.push(p);
        }
    });
    
    return allPositions;
}

// 获取所有交易历史 - 并行从多个端点获取
async function fetchAllTrades(addr) {
    const seen = new Set();
    const allTrades = [];
    
    // 并行从所有端点获取
    const results = await Promise.all([
        // Activity API - 主要端点
        paginate(`https://data-api.polymarket.com/activity?user=${addr}`, 2000, 100000),
        // Trades API
        paginate(`https://data-api.polymarket.com/trades?user=${addr}`, 2000, 100000),
        // Gamma API - maker
        paginate(`https://gamma-api.polymarket.com/trades?maker=${addr}`, 1000, 50000),
        // Gamma API - taker  
        paginate(`https://gamma-api.polymarket.com/trades?taker=${addr}`, 1000, 50000),
        // CLOB API
        paginate(`https://clob.polymarket.com/activity?user=${addr}`, 1000, 50000)
    ]);
    
    // 合并去重
    results.flat().forEach(item => {
        const key = genKey(item);
        if (!seen.has(key)) {
            seen.add(key);
            allTrades.push(processItem(item));
        }
    });
    
    // 按时间排序
    allTrades.sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp));
    
    return allTrades;
}

// 分页获取函数 - 快速并行版本
async function paginate(baseUrl, limit, maxItems) {
    const items = [];
    let offset = 0;
    const batchSize = 5; // 同时发起5个请求
    
    while (offset < maxItems) {
        // 创建批量请求
        const promises = [];
        for (let i = 0; i < batchSize && offset + i * limit < maxItems; i++) {
            const url = `${baseUrl}&limit=${limit}&offset=${offset + i * limit}`;
            promises.push(fetchWithTimeout(url, 5000));
        }
        
        const results = await Promise.all(promises);
        let gotData = false;
        
        for (const data of results) {
            if (data && data.length > 0) {
                items.push(...data);
                gotData = true;
            }
        }
        
        if (!gotData) break;
        
        offset += batchSize * limit;
        
        // 如果最后一批数据不满，说明没有更多了
        const lastResult = results[results.length - 1];
        if (!lastResult || lastResult.length < limit) break;
    }
    
    return items;
}

// 带超时的fetch
async function fetchWithTimeout(url, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!res.ok) return [];
        
        const data = await res.json();
        return Array.isArray(data) ? data : (data.trades || data.activity || data.positions || data.data || []);
    } catch (e) {
        clearTimeout(timeoutId);
        return [];
    }
}

function genKey(item) {
    return `${item.id||''}-${item.transactionHash||item.txHash||''}-${item.timestamp||item.createdAt||item.time||''}`;
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
                    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: contract, data }, 'latest'], id: 1 })
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
