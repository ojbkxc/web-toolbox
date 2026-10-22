// 从 spm-final.json 读取接口清单，生成 JMX 业务事务片段
// 需要先通过 MCP net_get 拉取每个接口的请求体，这里先输出 sampleId 列表
import { readFileSync, writeFileSync } from 'fs';

const spm = JSON.parse(readFileSync('spm-final.json', 'utf8'));

// 参考脚本已有的接口(不需要重复添加)
const refExisting = new Set([
  'oldpartHandleHead/findOldpartHandleHeadInfo',
  'serviceOrderDetail/queryTrackList',
  'warehouseManage/selectWarehouse',
]);

// 按业务模块分组(与抓包分析一致)
const moduleMap = {
  'inventory/selectAll': ['库存管理', '库存查询'],
  'inventory/selectUpWareHouseAll': ['库存管理', '上级库存查询'],
  'inventory/selectUpWareHouseCount': ['库存管理', '上级库存计数'],
  'inventory/findUpAvailAndStorageTotal': ['库存管理', '库存可用量与存储总量'],
  'warehouseManage/findGoodWarehouse': ['仓库管理', '良品仓库查询'],
  'warehouseManage/findOnhandFlag': ['仓库管理', '在库标记查询'],
  'pickingOrder/getPendingToPickingList': ['拣货管理', '待拣货列表'],
  'pickingOrder/getPendingToPickingListCount': ['拣货管理', '待拣货计数'],
  'pickingOrder/getPickingOrderListCount': ['拣货管理', '拣货单计数'],
  'logisticsOrder/getLogisticsOrderList': ['物流管理', '物流单查询'],
  'specialApplyHead/findSpecialApplyHeadList': ['特批管理', '特批单查询'],
  'specialApplyHead/findSpecialApplyType': ['特批管理', '特批类型查询'],
  'specialApplyDetail/findSpecialApplyData': ['特批管理', '特批明细查询'],
  'shortageApplyDetail/getAllShortageApplyHead': ['货损货差', '货损申请头查询'],
  'shortageApplyDetail/selectUnProcessShottageApply': ['货损货差', '未处理货损申请'],
  'oldpartHandleHead/findOldpartHandleHeadInfo': ['旧件管理', '旧件处理信息'],
  'warehouseAge/warehouseAgeSearch': ['库龄分析', '库龄查询'],
  'warehouseAgeHead/getWarehouseAgeHeadList': ['库龄分析', '库龄头列表'],
  'order/findordReturnOrder4Desensitize': ['订单管理', '退货订单查询(脱敏)'],
  'saleOrder/judgeCACEnable': ['订单管理', 'CAC启用判断'],
  'prTransPorts/queryPort': ['基础数据', '港口查询'],
  'ierpTransactionDetail/queryOutWarehouseCodeList': ['库存交易', '出库仓库列表'],
  'ierpTransactionDetail/selectAll': ['库存交易', '库存交易明细查询'],
  'serviceOrderDetail/queryTrackList': ['服务工单', '工单跟踪列表'],
  'aspInfoData/findMultiVendorsAll': ['基础数据', '供应商查询'],
  'businessType/find': ['基础数据', '业务类型查询'],
  'invBillType/selectInvBillTypeDropList': ['基础数据', '库存单据类型'],
  'orgOrganization/findOrgForBuMib': ['基础数据', 'MIB组织查询'],
  'parameter/getValue': ['基础数据', '参数值查询'],
};

const toAdd = spm.filter(s => {
  const path = s.interface.replace('POST /web/iservice-spm/', '').replace('GET /web/iservice-spm/', '');
  return !refExisting.has(path);
});

console.log(`需新增 ${toAdd.length} 个接口`);
for (const s of toAdd) {
  const path = s.interface.replace('POST /web/iservice-spm/', '').replace('GET /web/iservice-spm/', '');
  const mod = moduleMap[path] || ['未分类', path];
  console.log(`  [${mod[0]}] ${mod[1]}  →  ${s.interface}  sampleId=${s.sampleId}`);
}

// 输出 sampleId 列表供批量 net_get
const ids = toAdd.map(s => ({ id: s.sampleId, interface: s.interface, module: moduleMap[s.interface.replace('POST /web/iservice-spm/', '').replace('GET /web/iservice-spm/', '')] }));
writeFileSync('to-fetch.json', JSON.stringify(ids, null, 2));
console.log(`\nsampleId 列表已写入 to-fetch.json`);