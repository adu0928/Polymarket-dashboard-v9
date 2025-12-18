// api/lookup.js - 分页获取所有数据

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
        // 并行获取所有数据（分页）
        const [positions, allHistory, usdcBalance, profileData] = await Promise.all([
            fetchAllPositions(addr),
            fetchAllHistory(addr),
            fetchUSDCViaRPC(addr),
            fetchProfileData(addr)
        ]);

        // 计算统计
        const historyStats = calcHistoryStats(allHistory);
        const positionStats = calcPositionStats(positions);
        
        // 使用profile数据补充（如果可用）
        let portfolioValue = positionStats.currentValue;
        let realizedPnl = historyStats.realizedPnl;
        let totalVolume = historyStats.totalVolume;
        
        if (profileData) {
            if (profileData.positionsValue > 0) portfolioValue = profileData.positionsValue;
            if (profileData.profitLoss !== 0) realizedPnl = profileData.profitLoss;
            if (profileData.totalVolume > totalVolume) totalVolume = profileData.totalVolume;
        }

        return res.status(200).json({
            success: true,
            address: addr,
            stats: {
                usdcBalance: usdcBalance,
                positionCount: positions.length,
                portfolioValue: portfolioValue,
                investedAmount: positionStats.investedAmount,
                unrealizedPnl: positionStats.unrealizedPnl,
                totalTrades: allHistory.length,
                buyCount: historyStats.buyCount,
                sellCount: historyStats.sellCount,
                totalBuyVolume: historyStats.totalBuyVolume,
                totalSellVolume: historyStats.totalSellVolume,
                totalVolume: totalVolume,
                realizedPnl: realizedPnl,
                marketsParticipated: historyStats.marketsCount,
                activeDays: historyStats.activeDays,
                firstTradeDate: historyStats.firstDate,
                lastTradeDate: historyStats.lastDate,
                winningPositions: positionStats.winning,
                losingPositions: positionStats.losing,
                winRate: positionStats.winRate
            },
            positions: positions.slice(0, 100),
            history: allHistory.slice(0, 500)
        });
    } catch (error) {
        console.error('Lookup error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

// 获取用户profile数据
async function fetchProfileData(addr) {
    try {
        const urls = [
            `https://gamma-api.polymarket.com/users/${addr}`,
            `https://data-api.polymarket.com/users/${addr}`
        ];
        
        for (const url of urls) {
            try {
                const res = await fetch(url, {
                    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data) {
                        return {
                            positionsValue: parseFloat(data.positionsValue) || parseFloat(data.positions_value) || parseFloat(data.portfolioValue) || 0,
                            profitLoss: parseFloat(data.profitLoss) || parseFloat(data.profit_loss) || parseFloat(data.pnl) || parseFloat(data.allTimePnl) || 0,
                            totalVolume: parseFloat(data.volume) || parseFloat(data.totalVolume) || parseFloat(data.allTimeVolume) || 0
                        };
                    }
                }
            } catch (e) {}
        }
        return null;
    } catch (e) { return null; }
}

// 分页获取所有持仓
async function fetchAllPositions(addr) {
    const allPositions = [];
    const endpoints = [
        'https://data-api.polymarket.com/positions',
        'https://gamma-api.polymarket.com/positions'
    ];
    
    for (const baseUrl of endpoints) {
        let offset = 0;
        const limit = 500;
        let hasMore = true;
        
        while (hasMore && offset < 20000) {
            try {
                const url = `${baseUrl}?user=${addr}&limit=${limit}&offset=${offset}`;
                const res = await fetch(url, {
                    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
                });
                
                if (!res.ok) break;
                
                const data = await res.json();
                const positions = Array.isArray(data) ? data : (data.positions || data.data || []);
                
                if (positions.length === 0) {
                    hasMore = false;
                } else {
                    allPositions.push(...positions);
                    offset += limit;
                    if (positions.length < limit) hasMore = false;
                }
            } catch (e) {
                break;
            }
        }
        
        if (allPositions.length > 0) break;
    }
    
    // 去重
    const seen = new Set();
    return allPositions.filter(p => {
        const key = `${p.conditionId || p.marketId || p.id}-${p.outcome}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// 分页获取所有交易历史
async function fetchAllHistory(addr) {
    const allHistory = [];
    const seen = new Set();
    
    // 从多个endpoint获取
    const endpoints = [
        { url: 'https://data-api.polymarket.com/activity', param: 'user' },
        { url: 'https://data-api.polymarket.com/trades', param: 'user' },
        { url: 'https://gamma-api.polymarket.com/trades', param: 'maker' },
        { url: 'https://gamma-api.polymarket.com/trades', param: 'taker' }
    ];
    
    for (const endpoint of endpoints) {
        let offset = 0;
        const limit = 1000;
        let hasMore = true;
        let retries = 0;
        
        while (hasMore && offset < 100000 && retries < 3) {
            try {
                const url = `${endpoint.url}?${endpoint.param}=${addr}&limit=${limit}&offset=${offset}`;
                const res = await fetch(url, {
                    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
                });
                
                if (!res.ok) {
                    retries++;
                    continue;
                }
                
                const data = await res.json();
                const items = Array.isArray(data) ? data : (data.trades || data.activity || data.data || []);
                
                if (items.length === 0) {
                    hasMore = false;
                } else {
                    items.forEach(item => {
                        const key = `${item.id || ''}-${item.transactionHash || ''}-${item.timestamp || item.createdAt || Math.random()}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            allHistory.push(processHistoryItem(item));
                        }
                    });
                    
                    offset += limit;
                    if (items.length < limit) hasMore = false;
                    retries = 0;
                }
            } catch (e) {
                retries++;
                if (retries >= 3) break;
            }
        }
    }
    
    // 按时间排序
    allHistory.sort((a, b) => {
        const ta = parseTimestamp(a.timestamp);
        const tb = parseTimestamp(b.timestamp);
        return tb - ta;
    });
    
    return allHistory;
}

function processHistoryItem(item) {
    let type = determineTradeType(item);
    
    const amount = Math.abs(
        parseFloat(item.usdcSize) || 
        parseFloat(item.value) || 
        parseFloat(item.amount) || 
        parseFloat(item.size) * (parseFloat(item.price) || 1) || 
        0
    );
    
    return {
        id: item.id,
        type: type,
        market: item.title || item.marketSlug || item.market || item.question || item.conditionId || 'Unknown',
        outcome: item.outcome || item.outcomeName || '',
        amount: amount,
        price: parseFloat(item.price) || 0,
        profit: parseFloat(item.profit) || parseFloat(item.pnl) || parseFloat(item.realizedPnl) || 0,
        timestamp: item.timestamp || item.createdAt || item.time || item.blockTimestamp
    };
}

function determineTradeType(item) {
    const side = (item.side || '').toUpperCase();
    const type = (item.type || '').toLowerCase();
    const action = (item.action || '').toLowerCase();
    
    if (side === 'BUY' || side === 'B') return 'buy';
    if (side === 'SELL' || side === 'S') return 'sell';
    if (type.includes('buy') || type === 'b' || type === 'bid') return 'buy';
    if (type.includes('sell') || type === 's' || type === 'ask' || type === 'redeem') return 'sell';
    if (action.includes('buy') || action === 'b') return 'buy';
    if (action.includes('sell') || action === 's' || action === 'redeem') return 'sell';
    if (item.isBuy === true) return 'buy';
    if (item.isBuy === false) return 'sell';
    
    return 'trade';
}

async function fetchUSDCViaRPC(addr) {
    const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    
    let total = 0;
    const rpcUrls = ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon', 'https://polygon.llamarpc.com'];
    const paddedAddr = '000000000000000000000000' + addr.slice(2);
    const callData = '0x70a08231' + paddedAddr;
    
    for (const contract of [USDC_E, USDC_NATIVE]) {
        for (const rpcUrl of rpcUrls) {
            try {
                const response = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'eth_call',
                        params: [{ to: contract, data: callData }, 'latest'],
                        id: 1
                    })
                });
                
                if (response.ok) {
                    const json = await response.json();
                    if (json.result && json.result !== '0x' && json.result !== '0x0') {
                        const balance = parseInt(json.result, 16) / 1e6;
                        if (balance > 0) {
                            total += balance;
                        }
                        break;
                    }
                }
            } catch (e) {}
        }
    }
    
    return total;
}

function parseTimestamp(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') {
        return ts > 1e12 ? ts : ts * 1000;
    }
    const d = new Date(ts);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

function calcHistoryStats(history) {
    let buyCount = 0, sellCount = 0, totalBuyVolume = 0, totalSellVolume = 0, realizedPnl = 0;
    const markets = new Set(), days = new Set();
    let firstDate = null, lastDate = null;
    
    history.forEach(h => {
        if (h.type === 'buy') {
            buyCount++;
            totalBuyVolume += h.amount;
        } else if (h.type === 'sell') {
            sellCount++;
            totalSellVolume += h.amount;
            realizedPnl += h.profit || 0;
        } else {
            buyCount++;
            totalBuyVolume += h.amount;
        }
        
        if (h.market && h.market !== 'Unknown') {
            markets.add(h.market);
        }
        
        const ts = parseTimestamp(h.timestamp);
        if (ts > 0) {
            const d = new Date(ts);
            if (d.getFullYear() >= 2020 && d.getFullYear() <= 2030) {
                days.add(d.toDateString());
                const iso = d.toISOString();
                if (!firstDate || ts < parseTimestamp(firstDate)) firstDate = iso;
                if (!lastDate || ts > parseTimestamp(lastDate)) lastDate = iso;
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
        if (curr === 0 && size > 0) {
            curr = size * price;
        }
        
        let init = parseFloat(p.initialValue) || parseFloat(p.cost) || parseFloat(p.invested) || 0;
        if (init === 0 && size > 0 && avgPrice > 0) {
            init = size * avgPrice;
        }
        
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
