// ============================================================
// doc-supervisor 文档质量监督员（v0.3.0，v9-T5；能力边界 = plugin.json description + 本头注）
// 管什么：①nav.entry 质量体检页（全库分布 + P0/P1 发现 TopN + 分型统计）
//         ②两个 agent 工具：audit_doc_quality（单篇/低分 TopN 体检，证据制）
//                          quality_overview（全库质量分布一行概览）
//         ③行级「引用」：单篇发现组装完整提示词 → agent_handoff(asDraft) 预填小诺输入框，
//           用户审阅后发送（导航「引用到小诺」同款语义；写回仍经用户确认——能力边界不变）
// 管不了：不直接修改任何文档（重写建议交小诺，用户经 Diff 确认才执行——能力边界红线）；
//         不做出题与调度；不改体系树挂载；LLM 对标分析属 backlog（MVP 纯确定性，零模型调用）。
// 被谁调用：侧边栏「质量体检」入口；小诺对话（用户要求体检/质检某文档时）。
// 数据源：taxonomy_semantics 语义画像（v9 地基，ctx.query 只读）+ documents——零额外写权限。
// ============================================================
const { qualityScore, auditDoc, auditRows } = require('./lib/audit')

const PLUGIN_ID = 'doc-supervisor'
let moduleCtx = null

/** 画像体检 SQL：全部最新协议画像（与 taxonomy MAX(annotation_version) 对齐，版本自适应） */
const PROFILE_SQL = `
  SELECT d.id AS docId, COALESCE(d.title, '') AS title, d.file_path AS filePath,
         d.repo_id AS repoId, s.profile_json AS profileJson
  FROM documents d
  JOIN repositories r ON r.id = d.repo_id
  LEFT JOIN taxonomy_semantics s ON s.doc_id = d.id
    AND s.annotation_version = (SELECT MAX(annotation_version) FROM taxonomy_semantics)
  WHERE r.name != 'sys-hub' AND lower(d.file_path) LIKE '%.md'
    AND s.profile_json IS NOT NULL AND s.profile_json != '{}'`

async function loadAuditRows(ctx) {
  const rows = (await ctx.query(PROFILE_SQL)) || []
  return rows.filter((r) => r.docId)
}

async function activate(context) {
  moduleCtx = context

  // ---- 工具 1：单篇/低分 TopN 体检（证据制发现）----
  context.registerAgentTool(
    {
      name: 'audit_doc_quality',
      description: '对知识库文档做确定性质量体检（零 LLM）：返回质量分与证据制发现（P0 错误风险/P1 深度不足/P3 结构）。用户要求"检查文档质量/体检/这篇文档怎么样"时使用。指定 documentPath 体检单篇；缺省体检质量分最低的前 10 篇。',
      parameters: {
        type: 'object',
        properties: {
          documentPath: { type: 'string', description: '可选：要体检的文档路径；缺省体检全库低分 TopN' },
          limit: { type: 'number', description: '缺省模式返回的发现篇数上限，默认 10' },
        },
      },
    },
    async (args) => {
      const rows = await loadAuditRows(moduleCtx)
      if (!rows.length) return { output: '知识库暂无文档（或画像尚未构建）——先投递文档并等待语义标注完成。' }
      let targets
      let targetDoc = null
      if (args.documentPath) {
        const norm = String(args.documentPath).replace(/\\/g, '/').toLowerCase()
        targetDoc = rows.find((r) => String(r.filePath || '').replace(/\\/g, '/').toLowerCase() === norm)
        if (!targetDoc) return { output: '', error: `未找到文档（或无画像）: ${args.documentPath}` }
        targets = [targetDoc]
      } else {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30)
        targets = rows
          .map((r) => ({ row: r, score: qualityScore(r.profileJson) }))
          .sort((a, b) => a.score - b.score || String(a.row.docId).localeCompare(String(b.row.docId)))
          .slice(0, limit)
          .map((x) => x.row)
      }
      const lines = []
      for (const t of targets) {
        const { score, findings } = auditDoc(t)
        lines.push(`📄 《${t.title}》 质量分 ${score}/100`)
        if (findings.length === 0) lines.push('   ✅ 未发现风险项（各项基线达标）')
        for (const f of findings) {
          lines.push(`   ${f.level}〔${f.dimension}〕${f.evidence}`)
          lines.push(`      → ${f.suggestion}`)
        }
      }
      lines.push('')
      lines.push('体检口径：确定性画像探针（零模型断言）；重写请走「交给小诺」经用户确认——监督员不直接改文档。')
      return { output: lines.join('\n') }
    }
  )

  // ---- 工具 2：全库质量分布概览 ----
  context.registerAgentTool(
    {
      name: 'quality_overview',
      description: '知识库全库文档质量分布概览（零 LLM）：优/良/中/差分档统计 + P0 风险文档清单。用户问"知识库质量如何/哪些文档需要改进"时使用。',
      parameters: { type: 'object', properties: {} },
    },
    async () => {
      const rows = await loadAuditRows(moduleCtx)
      if (!rows.length) return { output: '知识库暂无文档（或画像尚未构建）。' }
      const { audited, findings, buckets } = auditRows(rows)
      const p0 = findings.filter((f) => f.level === 'P0')
      const lines = [
        `📊 全库质量分布（${audited.length} 篇，平均分 ${Math.round(audited.reduce((s, a) => s + a.score, 0) / audited.length)}）：`,
        `   优(≥85) ${buckets.优} · 良(70~84) ${buckets.良} · 中(50~69) ${buckets.中} · 差(<50) ${buckets.差}`,
        `P0 错误风险 ${p0.length} 篇${p0.length ? '：' + p0.slice(0, 5).map((f) => `《${f.title}》${f.dimension}`).join('、') + (p0.length > 5 ? ' 等' : '') : ''}`,
        '需要对单篇出具体建议时用 audit_doc_quality（可指定 documentPath）。',
      ]
      return { output: lines.join('\n') }
    }
  )

  context.log('doc-supervisor 已激活（确定性体检，零模型调用）')
}

async function deactivate() {
  if (moduleCtx) {
    moduleCtx.unregisterAgentTool('audit_doc_quality')
    moduleCtx.unregisterAgentTool('quality_overview')
  }
  moduleCtx = null
}

// ---- nav.entry 页面：质量体检总览（PackPage 契约：title/columns/rows/stats/secondaryActions）----
async function pageQualityAudit() {
  if (!moduleCtx) return { error: '文档质量监督员未激活' }
  const rows = await loadAuditRows(moduleCtx)
  if (!rows.length) return { title: '质量体检', columns: [], rows: [], message: '知识库暂无文档（或画像尚未构建）' }
  const { audited, findings, buckets } = auditRows(rows)
  const byId = new Map(audited.map((a) => [a.docId, a]))
  return {
    title: '质量体检',
    summary: `全库 ${audited.length} 篇 · 平均 ${Math.round(audited.reduce((s, a) => s + a.score, 0) / audited.length)} 分 · P0 风险 ${findings.filter((f) => f.level === 'P0').length} 项`,
    stats: [
      { label: '优 ≥85', value: buckets.优 },
      { label: '良 70~84', value: buckets.良 },
      { label: '中 50~69', value: buckets.中 },
      { label: '差 <50', value: buckets.差 },
    ],
    columns: [
      { key: 'title', label: '文档' },
      { key: 'score', label: '质量分' },
      { key: 'level', label: '最高风险' },
      // ellipsis：单元格省略截断，悬停 title 显示完整证据（2026-09-26 用户反馈）
      { key: 'evidence', label: '证据', ellipsis: true },
    ],
    rows: findings.slice(0, 20).map((f) => ({
      id: f.docId,
      title: `《${f.title}》`,
      score: byId.get(f.docId)?.score ?? '',
      level: f.level,
      evidence: f.evidence,
    })),
    secondaryActions: [
      { label: '体检最低分 10 篇（对话出建议）', method: 'handoffWorstDocs' },
    ],
    // 行级双动作（PackPage rowActions 数组契约）：打开直达编辑器；引用把发现组装完整提示词给小诺
    rowActions: [
      { label: '打开', method: 'openAuditedDoc', paramKey: 'id' },
      { label: '引用', method: 'citeFinding', paramKey: 'id' },
    ],
  }
}

/** 行级「打开」：按 docId 定位文档 → open_document 意图（编辑器 openFile+文件树联动） */
async function openAuditedDoc(docId) {
  if (!moduleCtx) return { error: '文档质量监督员未激活' }
  const rows = await loadAuditRows(moduleCtx)
  const hit = rows.find((r) => r.docId === docId)
  if (!hit) return { error: '文档不存在或无画像（可能已被删除/豁免）' }
  return { ui: { intent: 'open_document', filePath: hit.filePath } }
}

/** 行级「引用」：单篇全部发现组装完整提示词 → agent_handoff(asDraft) 预填小诺输入框。
 *  带发现清单而非只带文档：确定性体检的证据/建议直接进提示词，小诺免重诊（省一轮 token 且不断证据链）；
 *  asDraft 用户审阅后发送——分析出方案、写回经确认，插件不直接改文档的边界原样传递给小诺 */
async function citeFinding(docId) {
  if (!moduleCtx) return { error: '文档质量监督员未激活' }
  const rows = await loadAuditRows(moduleCtx)
  const hit = rows.find((r) => r.docId === docId)
  if (!hit) return { error: '文档不存在或无画像（可能已被删除/豁免）' }
  const { score, findings } = auditDoc(hit)
  if (!findings.length) return { message: `《${hit.title}》当前无体检发现（各项基线达标），无需引用。` }
  const list = findings
    .map((f, i) => `${i + 1}. [${f.level}·${f.dimension}] 证据：${f.evidence}\n   插件建议：${f.suggestion}`)
    .join('\n')
  const prompt = [
    `请分析文档《${hit.title}》的以下体检发现并给出改进方案（质量分 ${score}/100，来源：doc-supervisor 确定性体检）。`,
    `文档路径：${hit.filePath}`,
    '发现清单：',
    list,
    '要求：',
    '① 先用 read_document 通读全文，把每条发现定位到具体段落；',
    '② 逐条给出具体改进方案（改哪一段、补什么内容），只给方案不直接修改文件——我确认后才执行；',
    '③ 改动落地后用 audit_doc_quality 复检该文档，汇报前后分数变化。',
  ].join('\n')
  return {
    message: `已把《${hit.title}》的 ${findings.length} 条体检发现引用到小诺输入框（完整提示词），审阅后发送即可。`,
    ui: { intent: 'agent_handoff', message: prompt, asDraft: true },
  }
}

/** 页级动作：把最低分 10 篇的体检指令交给小诺（重写建议经用户确认才执行——边界红线） */
async function handoffWorstDocs() {
  if (!moduleCtx) return { error: '文档质量监督员未激活' }
  const rows = await loadAuditRows(moduleCtx)
  const worst = rows
    .map((r) => ({ row: r, score: qualityScore(r.profileJson) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 10)
  const list = worst.map((x) => `《${x.row.title}》（${x.score} 分）`).join('、')
  return {
    output: '',
    message: `已把最低分 10 篇交给小诺逐篇体检（当前：${list}）。体检属只读分析；任何重写都会先经你确认。`,
    // 契约字段是 message（core/types UIIntent；2026-09-26 修复：原 instruction 不符校验被静默丢弃）
    ui: { intent: 'agent_handoff', message: `请用 audit_doc_quality 逐篇体检以下低分文档并给出改进建议（只分析不修改）：${worst.map((x) => x.row.title).join('、')}` },
  }
}

module.exports = {
  id: PLUGIN_ID,
  name: '文档质量监督员',
  version: '0.3.0',
  description: '语义画像驱动的确定性质量体检：证据制发现 + 分型基线 + 四级分级；不直接改文档',
  activate,
  deactivate,
  pageQualityAudit,
  openAuditedDoc,
  citeFinding,
  handoffWorstDocs,
}
