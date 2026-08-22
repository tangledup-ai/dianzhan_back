// Mock API 客户端 - 用于开发测试
import * as mocks from '@/mocks'

// 模拟延迟
const delay = (ms: number = 100) => new Promise(resolve => setTimeout(resolve, ms))

// Mock API 客户端
export const mockClient = {
  get: async (url: string, config?: any) => {
    await delay()
    return { data: await handleGetRequest(url, config?.params) }
  },
  post: async (url: string, data?: any) => {
    await delay()
    return { data: await handlePostRequest(url, data) }
  },
  put: async (url: string, data?: any) => {
    await delay()
    return { data: await handlePutRequest(url, data) }
  },
  delete: async (url: string) => {
    await delay()
    return { data: await handleDeleteRequest(url) }
  },
}

// 处理 GET 请求
async function handleGetRequest(url: string, params?: any): Promise<any> {
  // 移除开头的 /api
  const path = url.startsWith('/api') ? url : `/api${url}`

  // 基础档案
  if (path === '/api/directory/brands') {
    return mocks.mockBrands
  }
  if (path === '/api/directory/entities') {
    return mocks.mockEntities
  }
  if (path === '/api/directory/landlords') {
    return mocks.mockLandlords
  }
  if (path === '/api/directory/shareholders') {
    return mocks.mockShareholders
  }
  if (path === '/api/directory/introducers') {
    return mocks.mockIntroducers
  }
  if (path === '/api/directory/entity-brands') {
    return mocks.mockEntityBrands
  }
  if (path === '/api/directory/platform-users') {
    return mocks.mockPlatformUsers
  }
  if (path === '/api/directory/third-party-configs') {
    return mocks.mockThirdPartyConfigs
  }

  // 站点
  if (path === '/api/stations') {
    return mocks.mockStations
  }
  if (path.match(/^\/api\/stations\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    return mocks.mockStations.find(s => s.id === id)
  }

  // 电表
  if (path === '/api/meters') {
    return mocks.mockMeters
  }
  if (path.match(/^\/api\/meters\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    return mocks.mockMeters.find(m => m.id === id)
  }

  // 预警（mock 备用：返回空结构，真实数据走后端）
  if (path === '/api/alerts' || path === '/api/alerts/config') {
    return {
      config: { elecYoyRatio: 1.5, expireDaysVenue: 30, expireDaysBrand: 30 },
      elecAnomalies: [],
      contractPayments: [],
      contractCollections: [],
    }
  }

  // 电费
  if (path === '/api/electricity') {
    return mocks.mockElectricity
  }
  if (path.match(/^\/api\/electricity\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    return mocks.mockElectricity.find(e => e.id === id)
  }
  // 电费月台账（mock 备用：返回空结构，真实数据走后端）
  if (path === '/api/electricity/monthly-ledger') {
    return { period: String(params?.period || ''), dim: params?.dim || 'landlord', rows: [], totals: { kwh: 0, payAmount: 0, collectAmount: 0, collectNet: 0, elecTax: 0, profit: 0 } }
  }
  // 电费收付明细导出（mock 备用：返回空结构，真实数据走后端）
  if (path === '/api/electricity/export') {
    return { period: String(params?.period || ''), dim: params?.dim || 'landlord', rows: [], groupTotals: [], totals: { kwh: 0, payAmount: 0, collectAmount: 0, collectNet: 0, profit: 0, opExpense: 0, profitAfterOp: 0, companyNetProfit: 0 } }
  }

  // 租金
  if (path === '/api/rent/leases') {
    return mocks.mockRentLeases
  }
  if (path === '/api/rent/incomes') {
    return mocks.mockRentIncomes
  }
  if (path === '/api/rent/receipts') {
    return mocks.mockRentReceipts
  }
  if (path === '/api/rent/payment-records') {
    return mocks.mockRentPaymentRecords
  }
  if (path === '/api/rent/income-records') {
    return mocks.mockRentIncomeRecords
  }
  if (path === '/api/rent/expenses') {
    return mocks.mockExpenses
  }
  // v2：美团 Excel 台账运行时解析已下线，返回空结构，前端降级到 contracts 数据
  if (path === '/api/rent/excel-data') {
    return { stations: [] }
  }
  // 场地费月台账（mock 备用：从 mockContracts 简易聚合，走真实后端时用后端接口）
  if (path === '/api/rent/monthly-ledger') {
    const period = String(params?.period || '').replace(/-/g, '')
    const dim = params?.dim || 'landlord'
    const covering = (mocks.mockContracts || []).filter((c: any) => {
      const s = c.startDate ? String(c.startDate).slice(0, 7).replace('-', '') : '000000'
      const e = (c.earlyEndDate || c.endDate) ? String(c.earlyEndDate || c.endDate).slice(0, 7).replace('-', '') : '999999'
      return s <= period && e >= period
    })
    const groups: Record<string, any> = {}
    for (const c of covering) {
      const key = dim === 'brand' ? `b${c.brandId}` : `l${c.landlordId}`
      const g = groups[key] || (groups[key] = {
        key: dim === 'brand' ? c.brandId : c.landlordId,
        name: dim === 'brand' ? (c.brandName || `品牌#${c.brandId}`) : (c.landlordName || `场地#${c.landlordId}`),
        rentIncome: 0, rentCost: 0, rentTax: 0, paidAmount: 0, pendingAmount: 0, contracts: [],
      })
      if (c.contractType === '品牌方合同') { g.rentIncome += Number(c.monthlyRent || 0) }
      else { g.rentCost += Number(c.monthlyRent || 0) }
      g.contracts.push(c)
    }
    const rows = Object.values(groups)
    const totals = rows.reduce((t: any, g: any) => ({
      rentIncome: t.rentIncome + g.rentIncome, rentCost: t.rentCost + g.rentCost,
      rentTax: t.rentTax + g.rentTax, paidAmount: 0, pendingAmount: 0,
    }), { rentIncome: 0, rentCost: 0, rentTax: 0, paidAmount: 0, pendingAmount: 0 })
    return { period, dim, rows, totals }
  }

  // 合同
  if (path === '/api/contracts') {
    return mocks.mockContracts
  }
  if (path.match(/^\/api\/contracts\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    return mocks.mockContracts.find(c => c.id === id)
  }
  if (path === '/api/contract-schedules/payment') {
    return mocks.mockContractSchedules.filter(s => s.side === 'payment')
  }
  if (path === '/api/contract-schedules/income') {
    return mocks.mockContractSchedules.filter(s => s.side === 'income')
  }

  // 分红
  if (path === '/api/dividends') {
    return mocks.mockDividends
  }
  if (path === '/api/dividends/configs/shareholder') {
    return mocks.mockShareholderConfigs
  }
  if (path === '/api/dividends/configs/introducer') {
    return mocks.mockIntroducerConfigs
  }
  if (path === '/api/dividends/summary/shareholder') {
    return mocks.mockShareholderSummary
  }
  if (path === '/api/dividends/summary/introducer') {
    return mocks.mockIntroducerSummary
  }

  // 审批
  if (path === '/api/approvals') {
    return mocks.mockApprovals
  }
  if (path.match(/^\/api\/approvals\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    return mocks.mockApprovals.find(a => a.id === id)
  }
  if (path === '/api/approvals/flows') {
    return mocks.mockApprovalFlows
  }

  // 看板
  if (path === '/api/overview') {
    return mocks.mockOverview
  }
  if (path === '/api/overview/monthly-detail') {
    return mocks.mockMonthlyDetail
  }
  if (path === '/api/overview/station-board') {
    return mocks.mockOverview.stationBoard
  }
  if (path === '/api/overview/brand-board') {
    return mocks.mockOverview.brandBoard
  }
  if (path === '/api/overview/entity-board') {
    return mocks.mockOverview.entityBoard
  }
  if (path === '/api/overview/landlord-board') {
    return mocks.mockOverview.landlordBoard
  }
  if (path === '/api/overview/shareholder-board') {
    return mocks.mockOverview.shareholderBoard
  }

  // 柜子
  if (path === '/api/cabinets') {
    if (params?.meterId) {
      return mocks.mockCabinets.filter(c => c.meterId === params.meterId)
    }
    return mocks.mockCabinets
  }

  // 电表能耗
  if (path === '/api/meter-energy/monthly') {
    if (params?.meterNo) {
      // 读数回填：返回该电表（address = meter_no）的真实月度读数；rawKwh=原始表码度数（编辑用，避免二次相乘）
      return mocks.mockMeterMonthly
        .filter((r: any) => r.address === params.meterNo)
        .map((r: any) => ({ ...r, rawKwh: r.kwh }))
    }
    return mocks.mockMeterEnergy.monthly
  }
  if (path === '/api/meter-energy/daily') {
    return mocks.mockMeterEnergy.daily
  }
  if (path === '/api/meter-energy/hourly') {
    return mocks.mockMeterEnergy.hourly
  }
  if (path === '/api/meter-energy/sync-logs') {
    return mocks.mockSyncLogs
  }

  // 用户
  if (path === '/api/auth/me') {
    return mocks.mockUsers[0] // 默认返回大老板
  }

  // 电费期间
  if (path === '/api/electricity/periods') {
    return ['2026-08', '2026-07', '2026-06']
  }

  // 站点位置
  if (path === '/api/stations/locations') {
    return mocks.mockStations.map(s => ({
      id: s.id,
      name: s.name,
      address: s.address,
      latitude: 25.0 + Math.random() * 0.1,
      longitude: 102.7 + Math.random() * 0.1,
      status: s.status,
    }))
  }

  // 审批统计
  if (path === '/api/approvals/stats/overview') {
    return {
      pending: mocks.mockApprovals.filter(a => a.status === '审批中').length,
      approved: mocks.mockApprovals.filter(a => a.status === '已通过').length,
      rejected: mocks.mockApprovals.filter(a => a.status === '已驳回').length,
    }
  }

  console.warn(`Mock API: 未处理的 GET 请求: ${url}`)
  return {}
}

// 处理 POST 请求
async function handlePostRequest(url: string, data?: any): Promise<any> {
  // 移除开头的 /api
  const path = url.startsWith('/api') ? url : `/api${url}`

  // 登录
  if (path === '/api/auth/login') {
    const { name, password } = data
    const user = mocks.mockUsers.find(u => u.name === name)
    if (user && password === '123456') {
      return {
        token: 'mock-token-' + Date.now(),
        user: user,
      }
    }
    throw new Error('姓名或密码错误')
  }

  // 创建站点
  if (path === '/api/stations') {
    const newStation = { id: mocks.mockStations.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockStations.push(newStation)
    return newStation
  }

  // 创建电表
  if (path === '/api/meters') {
    const newMeter = { id: mocks.mockMeters.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockMeters.push(newMeter)
    return newMeter
  }

  // 创建电费记录
  if (path === '/api/electricity') {
    const newElectricity = { id: mocks.mockElectricity.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockElectricity.push(newElectricity)
    return newElectricity
  }

  // 创建合同
  if (path === '/api/contracts') {
    const newContract = { id: mocks.mockContracts.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockContracts.push(newContract)
    return newContract
  }

  // 创建审批
  if (path === '/api/approvals') {
    const newApproval = { id: mocks.mockApprovals.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockApprovals.push(newApproval)
    return newApproval
  }

  // 同步电表数据
  if (path === '/api/meter-energy/sync') {
    return { success: true, message: '同步成功' }
  }

  // 创建柜子
  if (path === '/api/cabinets') {
    const newCabinet = { id: mocks.mockCabinets.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockCabinets.push(newCabinet)
    return newCabinet
  }

  // 创建租金付款合同
  if (path === '/api/rent/leases') {
    const newLease = { id: mocks.mockRentLeases.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockRentLeases.push(newLease)
    return newLease
  }

  // 创建租金收款合同
  if (path === '/api/rent/incomes') {
    const newIncome = { id: mocks.mockRentIncomes.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockRentIncomes.push(newIncome)
    return newIncome
  }

  // 创建租金收付款分期
  if (path === '/api/rent/receipts') {
    const newReceipt = { id: mocks.mockRentReceipts.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockRentReceipts.push(newReceipt)
    return newReceipt
  }

  // 创建合同收付款分期
  if (path === '/api/contract-schedules') {
    const newSchedule = { id: mocks.mockContractSchedules.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockContractSchedules.push(newSchedule)
    return newSchedule
  }

  // 创建分红配置
  if (path === '/api/dividends/configs/shareholder') {
    const newConfig = { id: mocks.mockShareholderConfigs.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockShareholderConfigs.push(newConfig)
    return newConfig
  }

  // 创建介绍人配置
  if (path === '/api/dividends/configs/introducer') {
    const newConfig = { id: mocks.mockIntroducerConfigs.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockIntroducerConfigs.push(newConfig)
    return newConfig
  }

  // 创建分红记录
  if (path === '/api/dividends') {
    const newDividend = { id: mocks.mockDividends.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockDividends.push(newDividend)
    return newDividend
  }

  // 创建基础档案
  if (path === '/api/directory/brands') {
    const newBrand = { id: mocks.mockBrands.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockBrands.push(newBrand)
    return newBrand
  }
  if (path === '/api/directory/entities') {
    const newEntity = { id: mocks.mockEntities.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockEntities.push(newEntity)
    return newEntity
  }
  if (path === '/api/directory/landlords') {
    const newLandlord = { id: mocks.mockLandlords.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockLandlords.push(newLandlord)
    return newLandlord
  }
  if (path === '/api/directory/shareholders') {
    const newShareholder = { id: mocks.mockShareholders.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockShareholders.push(newShareholder)
    return newShareholder
  }
  if (path === '/api/directory/introducers') {
    const newIntroducer = { id: mocks.mockIntroducers.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockIntroducers.push(newIntroducer)
    return newIntroducer
  }
  if (path === '/api/directory/platform-users') {
    const newUser = { id: mocks.mockPlatformUsers.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockPlatformUsers.push(newUser)
    return newUser
  }
  if (path === '/api/directory/third-party-configs') {
    const newConfig = { id: mocks.mockThirdPartyConfigs.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockThirdPartyConfigs.push(newConfig)
    return newConfig
  }

  // 创建租金收付款记录
  if (path === '/api/rent/payment-records') {
    const newRecord = { id: mocks.mockRentPaymentRecords.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockRentPaymentRecords.push(newRecord)
    return newRecord
  }
  if (path === '/api/rent/income-records') {
    const newRecord = { id: mocks.mockRentIncomeRecords.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockRentIncomeRecords.push(newRecord)
    return newRecord
  }

  // 创建运营费用
  if (path === '/api/rent/expenses') {
    const newExpense = { id: mocks.mockExpenses.length + 1, ...data, createdAt: new Date().toISOString() }
    mocks.mockExpenses.push(newExpense)
    return newExpense
  }

  // 创建电表读数
  if (path === '/api/meter-energy/readings') {
    return { success: true, message: '读数保存成功' }
  }

  console.warn(`Mock API: 未处理的 POST 请求: ${url}`)
  return {}
}

// 处理 PUT 请求
async function handlePutRequest(url: string, data?: any): Promise<any> {
  // 移除开头的 /api
  const path = url.startsWith('/api') ? url : `/api${url}`

  // 更新预警配置
  if (path === '/api/alerts/config') {
    return {
      elecYoyRatio: data?.elecYoyRatio ?? 1.5,
      expireDaysVenue: data?.expireDaysVenue ?? 30,
      expireDaysBrand: data?.expireDaysBrand ?? 30,
    }
  }

  // 更新站点
  if (path.match(/^\/api\/stations\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockStations.findIndex(s => s.id === id)
    if (index !== -1) {
      mocks.mockStations[index] = { ...mocks.mockStations[index], ...data }
      return mocks.mockStations[index]
    }
  }

  // 更新电表
  if (path.match(/^\/api\/meters\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockMeters.findIndex(m => m.id === id)
    if (index !== -1) {
      mocks.mockMeters[index] = { ...mocks.mockMeters[index], ...data }
      return mocks.mockMeters[index]
    }
  }

  // 更新电费记录
  if (path.match(/^\/api\/electricity\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockElectricity.findIndex(e => e.id === id)
    if (index !== -1) {
      mocks.mockElectricity[index] = { ...mocks.mockElectricity[index], ...data }
      return mocks.mockElectricity[index]
    }
  }

  // 更新合同
  if (path.match(/^\/api\/contracts\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockContracts.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockContracts[index] = { ...mocks.mockContracts[index], ...data }
      return mocks.mockContracts[index]
    }
  }

  // 更新审批状态
  if (path.match(/^\/api\/approvals\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockApprovals.findIndex(a => a.id === id)
    if (index !== -1) {
      mocks.mockApprovals[index] = { ...mocks.mockApprovals[index], ...data }
      return mocks.mockApprovals[index]
    }
  }

  // 更新柜子
  if (path.match(/^\/api\/cabinets\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockCabinets.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockCabinets[index] = { ...mocks.mockCabinets[index], ...data }
      return mocks.mockCabinets[index]
    }
  }

  // 更新租金付款合同
  if (path.match(/^\/api\/rent\/leases\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentLeases.findIndex(l => l.id === id)
    if (index !== -1) {
      mocks.mockRentLeases[index] = { ...mocks.mockRentLeases[index], ...data }
      return mocks.mockRentLeases[index]
    }
  }

  // 更新租金收款合同
  if (path.match(/^\/api\/rent\/incomes\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentIncomes.findIndex(i => i.id === id)
    if (index !== -1) {
      mocks.mockRentIncomes[index] = { ...mocks.mockRentIncomes[index], ...data }
      return mocks.mockRentIncomes[index]
    }
  }

  // 更新租金收付款分期
  if (path.match(/^\/api\/rent\/receipts\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentReceipts.findIndex(r => r.id === id)
    if (index !== -1) {
      mocks.mockRentReceipts[index] = { ...mocks.mockRentReceipts[index], ...data }
      return mocks.mockRentReceipts[index]
    }
  }

  // 更新合同收付款分期
  if (path.match(/^\/api\/contract-schedules\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockContractSchedules.findIndex(s => s.id === id)
    if (index !== -1) {
      mocks.mockContractSchedules[index] = { ...mocks.mockContractSchedules[index], ...data }
      return mocks.mockContractSchedules[index]
    }
  }

  // 更新分红配置
  if (path.match(/^\/api\/dividends\/configs\/shareholder\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockShareholderConfigs.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockShareholderConfigs[index] = { ...mocks.mockShareholderConfigs[index], ...data }
      return mocks.mockShareholderConfigs[index]
    }
  }

  // 更新介绍人配置
  if (path.match(/^\/api\/dividends\/configs\/introducer\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockIntroducerConfigs.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockIntroducerConfigs[index] = { ...mocks.mockIntroducerConfigs[index], ...data }
      return mocks.mockIntroducerConfigs[index]
    }
  }

  // 更新分红记录
  if (path.match(/^\/api\/dividends\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockDividends.findIndex(d => d.id === id)
    if (index !== -1) {
      mocks.mockDividends[index] = { ...mocks.mockDividends[index], ...data }
      return mocks.mockDividends[index]
    }
  }

  // 更新基础档案
  if (path.match(/^\/api\/directory\/brands\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockBrands.findIndex(b => b.id === id)
    if (index !== -1) {
      mocks.mockBrands[index] = { ...mocks.mockBrands[index], ...data }
      return mocks.mockBrands[index]
    }
  }
  if (path.match(/^\/api\/directory\/entities\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockEntities.findIndex(e => e.id === id)
    if (index !== -1) {
      mocks.mockEntities[index] = { ...mocks.mockEntities[index], ...data }
      return mocks.mockEntities[index]
    }
  }
  if (path.match(/^\/api\/directory\/landlords\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockLandlords.findIndex(l => l.id === id)
    if (index !== -1) {
      mocks.mockLandlords[index] = { ...mocks.mockLandlords[index], ...data }
      return mocks.mockLandlords[index]
    }
  }
  if (path.match(/^\/api\/directory\/shareholders\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockShareholders.findIndex(s => s.id === id)
    if (index !== -1) {
      mocks.mockShareholders[index] = { ...mocks.mockShareholders[index], ...data }
      return mocks.mockShareholders[index]
    }
  }
  if (path.match(/^\/api\/directory\/introducers\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockIntroducers.findIndex(i => i.id === id)
    if (index !== -1) {
      mocks.mockIntroducers[index] = { ...mocks.mockIntroducers[index], ...data }
      return mocks.mockIntroducers[index]
    }
  }
  if (path.match(/^\/api\/directory\/platform-users\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockPlatformUsers.findIndex(u => u.id === id)
    if (index !== -1) {
      mocks.mockPlatformUsers[index] = { ...mocks.mockPlatformUsers[index], ...data }
      return mocks.mockPlatformUsers[index]
    }
  }
  if (path.match(/^\/api\/directory\/third-party-configs\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockThirdPartyConfigs.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockThirdPartyConfigs[index] = { ...mocks.mockThirdPartyConfigs[index], ...data }
      return mocks.mockThirdPartyConfigs[index]
    }
  }

  // 更新租金收付款记录
  if (path.match(/^\/api\/rent\/payment-records\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentPaymentRecords.findIndex(r => r.id === id)
    if (index !== -1) {
      mocks.mockRentPaymentRecords[index] = { ...mocks.mockRentPaymentRecords[index], ...data }
      return mocks.mockRentPaymentRecords[index]
    }
  }
  if (path.match(/^\/api\/rent\/income-records\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentIncomeRecords.findIndex(r => r.id === id)
    if (index !== -1) {
      mocks.mockRentIncomeRecords[index] = { ...mocks.mockRentIncomeRecords[index], ...data }
      return mocks.mockRentIncomeRecords[index]
    }
  }

  // 更新运营费用
  if (path.match(/^\/api\/rent\/expenses\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockExpenses.findIndex(e => e.id === id)
    if (index !== -1) {
      mocks.mockExpenses[index] = { ...mocks.mockExpenses[index], ...data }
      return mocks.mockExpenses[index]
    }
  }

  console.warn(`Mock API: 未处理的 PUT 请求: ${url}`)
  return {}
}

// 处理 DELETE 请求
async function handleDeleteRequest(url: string): Promise<any> {
  // 移除开头的 /api
  const path = url.startsWith('/api') ? url : `/api${url}`

  // 删除站点
  if (path.match(/^\/api\/stations\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockStations.findIndex(s => s.id === id)
    if (index !== -1) {
      mocks.mockStations.splice(index, 1)
      return { success: true }
    }
  }

  // 删除电表
  if (path.match(/^\/api\/meters\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockMeters.findIndex(m => m.id === id)
    if (index !== -1) {
      mocks.mockMeters.splice(index, 1)
      return { success: true }
    }
  }

  // 删除电费记录
  if (path.match(/^\/api\/electricity\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockElectricity.findIndex(e => e.id === id)
    if (index !== -1) {
      mocks.mockElectricity.splice(index, 1)
      return { success: true }
    }
  }

  // 删除合同
  if (path.match(/^\/api\/contracts\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockContracts.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockContracts.splice(index, 1)
      return { success: true }
    }
  }

  // 删除审批
  if (path.match(/^\/api\/approvals\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockApprovals.findIndex(a => a.id === id)
    if (index !== -1) {
      mocks.mockApprovals.splice(index, 1)
      return { success: true }
    }
  }

  // 删除柜子
  if (path.match(/^\/api\/cabinets\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockCabinets.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockCabinets.splice(index, 1)
      return { success: true }
    }
  }

  // 删除租金付款合同
  if (path.match(/^\/api\/rent\/leases\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentLeases.findIndex(l => l.id === id)
    if (index !== -1) {
      mocks.mockRentLeases.splice(index, 1)
      return { success: true }
    }
  }

  // 删除租金收款合同
  if (path.match(/^\/api\/rent\/incomes\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentIncomes.findIndex(i => i.id === id)
    if (index !== -1) {
      mocks.mockRentIncomes.splice(index, 1)
      return { success: true }
    }
  }

  // 删除租金收付款分期
  if (path.match(/^\/api\/rent\/receipts\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentReceipts.findIndex(r => r.id === id)
    if (index !== -1) {
      mocks.mockRentReceipts.splice(index, 1)
      return { success: true }
    }
  }

  // 删除合同收付款分期
  if (path.match(/^\/api\/contract-schedules\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockContractSchedules.findIndex(s => s.id === id)
    if (index !== -1) {
      mocks.mockContractSchedules.splice(index, 1)
      return { success: true }
    }
  }

  // 删除分红配置
  if (path.match(/^\/api\/dividends\/configs\/shareholder\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockShareholderConfigs.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockShareholderConfigs.splice(index, 1)
      return { success: true }
    }
  }

  // 删除介绍人配置
  if (path.match(/^\/api\/dividends\/configs\/introducer\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockIntroducerConfigs.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockIntroducerConfigs.splice(index, 1)
      return { success: true }
    }
  }

  // 删除分红记录
  if (path.match(/^\/api\/dividends\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockDividends.findIndex(d => d.id === id)
    if (index !== -1) {
      mocks.mockDividends.splice(index, 1)
      return { success: true }
    }
  }

  // 删除基础档案
  if (path.match(/^\/api\/directory\/brands\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockBrands.findIndex(b => b.id === id)
    if (index !== -1) {
      mocks.mockBrands.splice(index, 1)
      return { success: true }
    }
  }
  if (path.match(/^\/api\/directory\/entities\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockEntities.findIndex(e => e.id === id)
    if (index !== -1) {
      mocks.mockEntities.splice(index, 1)
      return { success: true }
    }
  }
  if (path.match(/^\/api\/directory\/landlords\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockLandlords.findIndex(l => l.id === id)
    if (index !== -1) {
      mocks.mockLandlords.splice(index, 1)
      return { success: true }
    }
  }
  if (path.match(/^\/api\/directory\/shareholders\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockShareholders.findIndex(s => s.id === id)
    if (index !== -1) {
      mocks.mockShareholders.splice(index, 1)
      return { success: true }
    }
  }
  if (path.match(/^\/api\/directory\/introducers\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockIntroducers.findIndex(i => i.id === id)
    if (index !== -1) {
      mocks.mockIntroducers.splice(index, 1)
      return { success: true }
    }
  }
  if (path.match(/^\/api\/directory\/platform-users\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockPlatformUsers.findIndex(u => u.id === id)
    if (index !== -1) {
      mocks.mockPlatformUsers.splice(index, 1)
      return { success: true }
    }
  }
  if (path.match(/^\/api\/directory\/third-party-configs\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockThirdPartyConfigs.findIndex(c => c.id === id)
    if (index !== -1) {
      mocks.mockThirdPartyConfigs.splice(index, 1)
      return { success: true }
    }
  }

  // 删除租金收付款记录
  if (path.match(/^\/api\/rent\/payment-records\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentPaymentRecords.findIndex(r => r.id === id)
    if (index !== -1) {
      mocks.mockRentPaymentRecords.splice(index, 1)
      return { success: true }
    }
  }
  if (path.match(/^\/api\/rent\/income-records\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockRentIncomeRecords.findIndex(r => r.id === id)
    if (index !== -1) {
      mocks.mockRentIncomeRecords.splice(index, 1)
      return { success: true }
    }
  }

  // 删除运营费用
  if (path.match(/^\/api\/rent\/expenses\/\d+$/)) {
    const id = parseInt(path.split('/').pop() || '0')
    const index = mocks.mockExpenses.findIndex(e => e.id === id)
    if (index !== -1) {
      mocks.mockExpenses.splice(index, 1)
      return { success: true }
    }
  }

  console.warn(`Mock API: 未处理的 DELETE 请求: ${url}`)
  return {}
}
