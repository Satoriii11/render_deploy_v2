import assert from 'node:assert/strict';
import {riskPresentation,optimizePresentation,recoveryPresentation,humanizeText,classifyRestriction,groupRestrictions} from '../lib/presentation.mjs';
import {decisionReport,delayAnalysis} from '../lib/decision.mjs';
const req={id:'REQ-001',company:'示例采购企业',product:'示例元器件',quantity:117};
const cat={requests:[req],supplierNames:new Map([['COM-023','示例供应商']]),productNames:new Map([['ELE-0001','示例元器件'],['SIM-ALT-0001-A','示例元器件（升级款）']])};
const risk=riskPresentation({suppliers:[{supplier_id:'COM-023',supplier_name:'示例供应商',delivery_risk_D:10,quality_risk_Q:20,concentration_risk_S:30,best_eligible_risk:21,quotes:[{sku_id:'ELE-0001',capacity:30,delivery_date:'2026-11-15',cost_risk_C:22,total_risk_R:21,risk_level:'低风险',auto_eligible:true,reasons:[]}]}]},cat,req);
assert.match(risk.answer,/交付D/);assert.match(risk.answer,/成本C/);assert.equal(risk.charts[0].points.length,1);
const plan={total_quantity:117,total_cost:4894.29,average_risk:24.5,budget_remaining:500,allocation:[{supplier_name:'示例供应商',quantity:117,subtotal:4894.29,risk:24.5}]};
const purchase=optimizePresentation({demand:117,cost_plan:plan,risk_plan:{...plan,total_cost:5200,average_risk:23.2}},cat,req);
assert.equal(purchase.charts.length,3);assert.equal(purchase.charts[2].type,'splitBar');assert.equal(purchase.charts[2].plans.length,2);
const recovery=recoveryPresentation({recovery:{shortage_quantity:19,remaining_budget:1000,confirmed_extra_quantity:0,recovery_actions:[]},candidate:{candidates:[{sku_id:'SIM-ALT-0001-A',category:'PENDING_ENGINEERING',technical_difference:'容量升级'}]},feasibility:{evaluated_quotes:[{supplier_name:'示例供应商',sku_id:'SIM-ALT-0001-A',status:'PENDING_APPROVAL_AND_CONFIRMATION',possible_quantity_before_approval:19,estimated_incremental_cost:850}],confirmed_extra_quantity:0}},cat,req);
assert.match(recovery.answer,/条件性可行报价明细/);assert.match(recovery.answer,/示例元器件（升级款）/);assert.ok(recovery.charts.every(c=>c.title!=='原件'));
const basePlan={fulfilled_quantity:98,unmet_quantity:19,total_cost:4000,average_risk:25,allocation:[]};
const scenario={request_id:'REQ-001',request_info:{company:req.company,product:req.product,quantity:117},demand:117,budget:5000,disrupted_supplier_name:'示例供应商',disruption_rate:1,reoptimized_cost_plan:basePlan,reoptimized_risk_plan:basePlan,delay:{deadline:'2026-11-15',evaluationDate:'2026-11-01',pools:[],quotes:[{id:'QUOTE-X',supplierId:'COM-023',supplier:'示例供应商',arrival:'2026-11-17',capacity:25,pool:'',unit:4000,fixed:0}]}};
const disruption=decisionReport(scenario,{comparisons:{}});assert.deepEqual(disruption.charts.map(c=>c.type),['fulfillment','efficiency']);
const delay=delayAnalysis(scenario,'cost',12);assert.equal(delay.charts[0].type,'line');assert.deepEqual(delay.charts[0].points.map(p=>p.x),[0,2]);assert.equal(delay.charts[0].points.at(-1).value,0);assert.doesNotMatch(delay.answer,/QUOTE-X/);
assert.equal(humanizeText('采购请求 REQ-001，企业 COM-023，物料 ELE-0001。',cat),'采购请求 示例采购企业的示例元器件采购需求，企业 示例供应商，物料 示例元器件。');
console.log('PASS: supplier risk, purchase optimization, disruption, recovery, delay scenarios, chart types, ID-to-name presentation');

// A five-day earliest completion keeps the 3-day partial-fill milestone.
const partial={...scenario,delay:{...scenario.delay,quotes:[
  {id:'A',supplierId:'COM-A',supplier:'甲公司',arrival:'2026-11-18',capacity:3,pool:'',unit:10000,fixed:0},
  {id:'B',supplierId:'COM-B',supplier:'乙公司',arrival:'2026-11-20',capacity:4,pool:'',unit:10000,fixed:0},
]}};
const baseSeven={...basePlan,unmet_quantity:7};
partial.reoptimized_cost_plan=baseSeven;
partial.reoptimized_risk_plan=baseSeven;
const byFive=delayAnalysis(partial,'cost',12);
assert.deepEqual(byFive.charts[0].points.map(p=>p.x),[0,3,5]);
assert.deepEqual(byFive.charts[0].points.map(p=>p.value),[7,4,0]);
assert.doesNotMatch(byFive.answer,/7 天 \|/);

assert.equal(classifyRestriction('共享库存池没有剩余容量'),'库存或可供能力不足');
assert.equal(classifyRestriction('非完全匹配原件，需工程审核'),'技术匹配与工程审批');
assert.equal(classifyRestriction('预计到货晚于要求到货日期'),'交期不满足');
const reasons=groupRestrictions([
 {company:'甲公司',reasons:['交期不满足','共享库存池没有剩余容量']},
 {company:'乙公司',reasons:['预计到货晚于要求到货日期']},
 {company:'甲公司',reasons:['预计到货晚于要求到货日期']},
]);
assert.equal(reasons[0].category,'交期不满足');
assert.deepEqual(reasons[0].companies,['甲公司','乙公司']);
assert.equal(reasons[0].count,3);
assert.equal(reasons[1].count,1);
console.log('PASS V6: grouped restrictions with suppliers; first complete delay stops; comparison panel schemas');
// Beyond-10-day recovery must preserve standard thresholds plus actual first full day.
const afterTwelve={...scenario,delay:{...scenario.delay,quotes:[
  {id:'LATE',supplierId:'COM-Z',supplier:'晚到企业',arrival:'2026-11-29',capacity:7,pool:'',unit:10000,fixed:0},
]}};
afterTwelve.reoptimized_cost_plan={...basePlan,unmet_quantity:7};
const late=delayAnalysis(afterTwelve,'cost',12);
assert.deepEqual(late.charts[0].points.map(p=>p.x),[0,3,5,7,10,12,14]);
assert.equal(late.charts[0].points.at(-1).value,0);
// Supplier-to-category mapping is not flattened to raw explanation counts.
const multi=groupRestrictions([{company:'深圳某供应商',reasons:['非完全匹配原件，需工程审核；共享库存池没有剩余容量']}]);
assert.deepEqual(multi.map(g=>g.category),['库存或可供能力不足','技术匹配与工程审批']);
console.log('PASS V6: eventual first-fill beyond preset thresholds, merged reason splitting');
