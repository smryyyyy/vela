import type { WorkflowDefinition } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../ipc-client'
import type { BlueprintData } from '../../../electron/repositories/blueprint-repository'
import { stripThinkingTags } from './workflow-utils'

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================

export type ChapterBlueprint = BlueprintData

const EMPTY_BLUEPRINT: ChapterBlueprint = {
  chapterNumber: 0,
  title: '',
  role: '发展',
  purpose: '',
  keyEvents: '',
  characters: [],
  suspenseHook: '',
  userGuidance: '',
  notes: '',
  notesUpdatedAt: '',
}

/**
 * 修复 LLM 生成的 JSON 常见语法错误（冒号缺失、尾随逗号等）
 */
function repairJSON(text: string): string {
  let fixed = text
  // 1. 修复 "blueprints": { ... 应该是数组 "blueprints": [{ ... }]
  fixed = fixed.replace(/"blueprints":\s*\{/g, '"blueprints": [{')
  // 2. 修复最外层 } 后面可能是 }} 需要变成 }]
  fixed = fixed.replace(/\}\s*$/g, '}]')
  // 3. 修复属性名后缺冒号: "key" "value" → "key": "value"
  fixed = fixed.replace(/"(\w+)"\s+(?=(?:"|\[|\{|\d+|true|false|null))/g, '"$1": ')
  // 4. 修复数组/对象最后一个元素后的尾随逗号
  fixed = fixed.replace(/,\s*([}\]])/g, '$1')
  return fixed
}

/** 安全 JSON 解析（带自动修复） */
function safeParseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const repaired = repairJSON(text)
    return JSON.parse(repaired)
  }
}

/**
 * 从 LLM 回复中逐个提取章节对象（JSON 整体格式混乱时的兜底方案）
 * 匹配 { "chapterNumber": N, ... } 的独立对象并分别解析
 */
function extractChaptersFallback(text: string): ChapterBlueprint[] {
  const chapters: ChapterBlueprint[] = []
  const chapterRegex = /\{\s*"chapter(?:Number|_number)"\s*:\s*(\d+)\s*[^}]*\}/g
  let match
  while ((match = chapterRegex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[0])
      chapters.push({
        ...EMPTY_BLUEPRINT,
        chapterNumber: Number(obj.chapterNumber || obj.chapter_number || 0),
        title: String(obj.title || `第${obj.chapterNumber}章`),
        role: String(obj.role || '发展'),
        purpose: String(obj.purpose || ''),
        keyEvents: String(obj.keyEvents || obj.key_events || ''),
        characters: Array.isArray(obj.characters) ? obj.characters : [],
        suspenseHook: String(obj.suspenseHook || obj.suspense_hook || ''),
        userGuidance: '',
      })
    } catch {
      // 单个对象解析失败则跳过
    }
  }
  return chapters
}

export interface DirectoryWorkflowParams {
  mode: 'full' | 'append'
  startChapter?: number
  count?: number
  /** 节奏/风格指导（可选） */
  pacingGuidance?: string
}

// ==========================================
// 2. 蓝图文件访问与工具函数
// ==========================================

export function parseTextBlueprints(content: string, startNum: number, endNum: number, log?: (msg: string) => void): ChapterBlueprint[] {
  let result: ChapterBlueprint[] = []

  try {
    const cleanContent = stripThinkingTags(content)
    const jsonStr = cleanContent.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()
    const startIndex = jsonStr.indexOf('{')
    const endIndex = jsonStr.lastIndexOf('}')

    if (startIndex !== -1 && endIndex !== -1) {
      const arrayStr = jsonStr.substring(startIndex, endIndex + 1)
      let parsed = safeParseJSON(arrayStr)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'blueprints' in parsed) {
        parsed = (parsed as Record<string, unknown>).blueprints
      }
      // 兼容 blueprints 值是单个对象而非数组的情况
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'chapterNumber' in parsed) {
        parsed = [parsed]
      }
      if (Array.isArray(parsed)) {
        result = parsed
          .filter((p: Record<string, unknown>) => {
            const n = Number(p.chapterNumber || p.chapter_number)
            return n >= startNum && n <= endNum
          })
          .map((p: Record<string, unknown>) => ({
            ...EMPTY_BLUEPRINT,
            chapterNumber: Number(p.chapterNumber || p.chapter_number || 0),
            title: String(p.title || `第${p.chapterNumber}章`),
            role: String(p.role || '发展'),
            purpose: String(p.purpose || ''),
            keyEvents: String(p.keyEvents || p.key_events || ''),
            characters: Array.isArray(p.characters) ? p.characters : [],
            suspenseHook: String(p.suspenseHook || p.suspense_hook || ''),
            userGuidance: '',
          }))
      }
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    // 兜底：从混乱的文本中逐个提取章节对象
    const fallback = extractChaptersFallback(content).filter(p => p.chapterNumber >= startNum && p.chapterNumber <= endNum)
    if (fallback.length > 0) {
      log?.('✅ 兜底解析成功，提取到 ' + fallback.length + ' 章')
      result = fallback
    } else {
      log?.('⚠️ 蓝图 JSON 解析失败: ' + errMsg + '，原始响应(前1500字)：' + content.slice(0, 1500))
      console.error('Failed to parse blueprint JSON', content)
    }
  }

  const distinctMap = new Map<number, ChapterBlueprint>()
  for (const item of result) {
    if (!distinctMap.has(item.chapterNumber)) distinctMap.set(item.chapterNumber, item)
  }

  return Array.from(distinctMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export async function loadDirectoryBlueprints(): Promise<ChapterBlueprint[]> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.sort((a, b) => a.chapterNumber - b.chapterNumber)
  } catch {
    return []
  }
}

export async function saveChapterBlueprint(blueprint: ChapterBlueprint): Promise<void> {
  await ipc.invoke('db:blueprint-upsert', blueprint)
}

export async function saveAllBlueprints(blueprints: ChapterBlueprint[]): Promise<void> {
  await ipc.invoke('db:blueprint-upsert-many', blueprints)
}

export async function getBlueprintCount(): Promise<number> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.length
  } catch {
    return 0
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// ==========================================

export function createDirectoryWorkflow(params: DirectoryWorkflowParams = { mode: 'full' }): WorkflowDefinition {
  return {
    type: 'directory',
    title: params.mode === 'append' ? `📋 续写章节蓝图${params.startChapter ? `（从第 ${params.startChapter} 章）` : ''}` : '📋 生成章节蓝图（全量）',
    steps: [
      {
        name: '读取架构',
        description: `从 SQLite 加载项目架构信息`,
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error('未打开项目')

          callbacks.log('读取项目架构信息...')
          const core = await ipc.invoke('db:project-core-get')
          if (!core) throw new Error('项目核心数据未初始化')

          const parts: string[] = []
          if (core.premise && core.premise.length > 50) parts.push(core.premise)
          if (core.charactersArch && core.charactersArch.length > 50) parts.push(core.charactersArch)
          if (core.worldbuilding && core.worldbuilding.length > 50) parts.push(core.worldbuilding)
          if (core.synopsis && core.synopsis.length > 50) parts.push(core.synopsis)

          if (parts.length === 0) throw new Error('项目主要架构均未生成')

          context.data.architecture = parts.join('\n\n---\n\n')
          // 注入节奏指导到 context，供 Command 读取
          if (params.pacingGuidance) context.data.pacingGuidance = params.pacingGuidance
          if (params.mode === 'append') {
            const existing = await loadDirectoryBlueprints()
            context.data.existingBlueprints = existing
            callbacks.log(`已加载 ${existing.length} 章已有蓝图`)
          }
          return `架构加载完成（${parts.length} 段）`
        },
      },
      {
        name: '生成蓝图',
        description: '基于架构文件生成全书章节蓝图',
        executor: async (_step, context, callbacks) => {
          const { GenerateDirectoryCommand } = await import('./commands/directory.command')
          const cmd = new GenerateDirectoryCommand(params)
          const blueprints = await cmd.execute({ step: _step, context, callbacks })
          // 返回可读摘要字符串（step.result 必须是 string，否则 AIOutputPanel 渲染会崩溃）
          return `已生成 ${blueprints.length} 章蓝图`
        },
      },
      {
        name: '保存蓝图',
        description: `将章节蓝图批量写入 SQLite 数据库`,
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error('未打开项目')

          const newBlueprints = context.data.newBlueprints as ChapterBlueprint[]
          const existingBlueprints = context.data.existingBlueprints as ChapterBlueprint[]

          callbacks.log('保存蓝图到数据库...')

          let merged: ChapterBlueprint[]
          if (params.mode === 'full') {
            merged = newBlueprints
            // TODO: 若需要清理冗余蓝图，可考虑添加 db:blueprint-delete-all 以严格符合全量替换的意图。
            // 在当前 upsert-many 中，仅覆盖更新
          } else {
            const existingMap = new Map(existingBlueprints.map(b => [b.chapterNumber, b]))
            for (const nb of newBlueprints) existingMap.set(nb.chapterNumber, nb)
            merged = Array.from(existingMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
          }

          await saveAllBlueprints(merged)
          useProjectStore.getState().refreshFileTree()
          return '已保存蓝图'
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: params.mode === 'append' ? '✅ 续写蓝图生成完成' : '✅ 全书章节蓝图已生成完成！',
    },
  }
}
