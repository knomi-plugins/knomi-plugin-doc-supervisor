// ============================================================
// doc-supervisor - 文档质量体检纯函数引擎（v0.1.0，v9-T5 能力边界见 plugin.json）
// 管什么：从语义画像（profile_json）+ 质量信号确定性探针产出「证据制发现 + 确定性质量分」——
//   qualityScore(profile)：0~100 确定性公式（常量冻结，改动=插件发版，对标 matcher 纪律）
//   auditDoc(row)：单篇发现清单，每条 {level, dimension, evidence, suggestion, confidence}——
//     P0 错误风险（TODO/占位未完成信号；画像无法支撑消费）→ P1 深度不足（教程无代码/概念稀薄）
//     → P3 结构建议（无层级结构）。P2 时效（技术版本词过期）为 backlog，MVP 不做。
//   auditRows(rows)：全库体检——发现按 P0→P3 分级、同级按分数升序（最差在前）。
// 不管什么：取数（index.js 经 ctx.query）；文档修改（能力边界：不直接改文档，重写建议
//   走「交给小诺」由用户确认）；LLM 对标分析（backlog）。
// 被谁调用：index.js 的 audit_doc_quality / quality_overview 工具与 pageQualityAudit 页面。
// 纪律：纯函数——同输入必同输出（S12 质量分确定性）；画像缺失按最低画像降级，绝不抛错；
//   「无证据不建议」——每条发现必须携带 evidence 字段（防过度自信的审查官，v9 计划 §2.5）。
// ============================================================

/** 分型质量基线（冻结；改动=发版）：doc_type → 该类型文档的客观检查表 */
const DOC_TYPE_BASELINES = {
  教程: { needsCode: true, minConcepts: 3 },
  笔记: { needsCode: false, minConcepts: 3 },
  速查: { needsCode: false, minConcepts: 2 },
  题解: { needsCode: true, minConcepts: 2 },
  总结: { needsCode: false, minConcepts: 3 },
  日志: { needsCode: false, minConcepts: 0 },
}

/** 质量分权重（冻结；总分封顶 100） */
const SCORE_WEIGHTS = {
  base: 50,
  complete: 15,
  hasCode: 10,
  hasRefs: 5,
  structured: 10,
  difficulty: 5,
  docType: 5,
  conceptsRich: 5,
  keyPointsRich: 5,
}

/** 解析画像行（queryReadOnly 驼峰列）；损坏/缺失按最低画像降级 */
function parseProfileRow(profileJson) {
  try {
    const p = JSON.parse(profileJson || '{}') || {}
    return {
      concepts: Array.isArray(p.concepts) ? p.concepts.filter(Boolean) : [],
      prerequisites: Array.isArray(p.prerequisites) ? p.prerequisites.filter(Boolean) : [],
      difficulty: typeof p.difficulty === 'string' ? p.difficulty : '',
      docType: typeof p.docType === 'string' ? p.docType : '',
      qualitySignals: p.qualitySignals && typeof p.qualitySignals === 'object' ? p.qualitySignals : {},
      keyPoints: Array.isArray(p.keyPoints) ? p.keyPoints.filter(Boolean) : [],
    }
  } catch {
    return { concepts: [], prerequisites: [], difficulty: '', docType: '', qualitySignals: {}, keyPoints: [] }
  }
}

/** 确定性质量分（0~100）：同画像必同分，无随机/时序因素（S12） */
function qualityScore(profileJson) {
  const p = parseProfileRow(profileJson)
  const q = p.qualitySignals
  let s = SCORE_WEIGHTS.base
  if (q.complete !== false) s += SCORE_WEIGHTS.complete
  if (q.hasCode) s += SCORE_WEIGHTS.hasCode
  if (q.hasRefs) s += SCORE_WEIGHTS.hasRefs
  if (q.structured) s += SCORE_WEIGHTS.structured
  if (p.difficulty) s += SCORE_WEIGHTS.difficulty
  if (p.docType) s += SCORE_WEIGHTS.docType
  if (p.concepts.length >= 3) s += SCORE_WEIGHTS.conceptsRich
  if (p.keyPoints.length >= 3) s += SCORE_WEIGHTS.keyPointsRich
  return Math.max(0, Math.min(100, s))
}

/**
 * 单篇体检：返回 { score, findings[] }。每条发现必带 evidence（画像字段/探针事实）——
 * 无证据不建议（能力边界）；confidence 恒 high（全部来自确定性信号，无模型断言）。
 */
function auditDoc(row) {
  const p = parseProfileRow(row.profileJson)
  const q = p.qualitySignals
  const baseline = DOC_TYPE_BASELINES[p.docType] || DOC_TYPE_BASELINES.笔记
  const findings = []
  const push = (level, dimension, evidence, suggestion) =>
    findings.push({ level, dimension, evidence, suggestion, confidence: 'high' })

  // P0 错误风险
  if (q.complete === false) {
    push('P0', '完整性', '质量探针发现 TODO/待补充/占位符等未完成信号', '补全未完成段落或删除占位内容；可交给小诺重写（经确认后执行）')
  }
  if (p.concepts.length === 0 && p.keyPoints.length === 0) {
    push('P0', '内容密度', '标引未能提取任何概念与核心论断——正文可能为空壳/清单堆砌', '充实正文论述；若为流水/日志类可忽略（日志基线不考察概念）')
  }

  // P1 深度不足（分型基线）
  if (baseline.needsCode && !q.hasCode) {
    push('P1', '示例完备', `docType=${p.docType || '(未标注,按笔记基线)'} 基线要求代码示例，正文未检出代码块`, '补充可运行示例；交给小诺按基线补写（经确认后执行）')
  }
  if (p.concepts.length > 0 && p.concepts.length < baseline.minConcepts) {
    push('P1', '概念覆盖', `提取概念 ${p.concepts.length} 个 < ${p.docType || '笔记'}基线 ${baseline.minConcepts} 个`, '补齐核心概念的定义/对比/关联章节')
  }

  // P3 结构建议
  if (!q.structured) {
    push('P3', '结构化', '正文未检出多级标题（≥2 个 # 标题）', '增加标题层级提升可导航性（建议级，可忽略）')
  }

  return { score: qualityScore(row.profileJson), findings }
}

/** 全库体检：发现按 P0<P1<P3 分级排序、同级分数升序（最差在前）；附分档分布 */
function auditRows(rows) {
  const audited = (rows || []).map((r) => {
    const { score, findings } = auditDoc(r)
    return { docId: r.docId, title: r.title, filePath: r.filePath, score, findings }
  })
  const levelOrder = { P0: 0, P1: 1, P3: 2 }
  const flat = []
  for (const a of audited) for (const f of a.findings) flat.push({ ...f, docId: a.docId, title: a.title, score: a.score })
  flat.sort((x, y) => levelOrder[x.level] - levelOrder[y.level] || x.score - y.score || String(x.docId).localeCompare(String(y.docId)))
  const buckets = { 优: 0, 良: 0, 中: 0, 差: 0 }
  for (const a of audited) {
    if (a.score >= 85) buckets.优++
    else if (a.score >= 70) buckets.良++
    else if (a.score >= 50) buckets.中++
    else buckets.差++
  }
  return { audited, findings: flat, buckets }
}

module.exports = { qualityScore, auditDoc, auditRows, parseProfileRow, DOC_TYPE_BASELINES, SCORE_WEIGHTS }
