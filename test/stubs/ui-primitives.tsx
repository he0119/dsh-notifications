/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的测试替身。
 *
 * 真实包是一个大控件库：它的产物直接 import 了 shiki、katex、micromark、simple-icons 等一整套渲染
 * 依赖（却没有在自己的 package.json 里声明）。本包的界面只用它的几个入口——按钮、开关、状态点、
 * 设置表单外框，以及「关掉最上层弹窗」这两个函数——为一次测试渲染把整套代码编辑/图标栈装进开发依赖
 * 并不划算。
 *
 * 替身只保证**语义**：可访问名字、禁用状态、勾选与点击都照真实控件的行为走；外观不参与断言。
 * 官方控件自身的渲染由宿主负责，本包测的是自己那一层接线。
 */
import type { CSSProperties, ReactNode, Ref } from 'react'
import { createElement, useEffect, useRef } from 'react'

/** 关掉最上层弹窗用的选择器：真实包认它自己那套 class，这里只认测试里用 `data-shortcut-modal` 标出来的弹窗。 */
export const modalSelector = '[data-shortcut-modal]'

/** 已经打开的弹窗层，按打开顺序排列；真实包也是这么认「最上面那层」的。 */
const layers: { dismiss: () => void }[] = []

/**
 * 关掉最上层弹窗：调用那一层挂载时登记的关闭回调，由 React 自己把节点摘掉。
 *
 * 不能直接 `node.remove()`：那个节点归 React 管，先摘掉会让 React 之后的卸载抛
 * `NotFoundError: The node to be removed is not a child of this node`。
 */
export function closeTopModal(_root?: Document): boolean {
  const layer = layers.at(-1)
  if (layer === undefined) return false
  layer.dismiss()
  return true
}

interface ButtonProps {
  children?: ReactNode
  disabled?: boolean
  onClick?: () => void
  size?: string
  variant?: string
  className?: string
  style?: CSSProperties
  'aria-label'?: string
  title?: string
  type?: 'button' | 'submit'
}

/** 真实按钮的最小等价物：`size` / `variant` 是外观属性，不进 DOM。 */
export function Button({ children, disabled, onClick, className, style, type = 'button', ...rest }: ButtonProps) {
  return createElement(
    'button',
    {
      type,
      disabled,
      onClick,
      className,
      style,
      'aria-label': rest['aria-label'],
      title: rest.title,
      'data-stub': 'button',
    },
    children,
  )
}

interface SwitchProps {
  label: string
  checked?: boolean
  disabled?: boolean
  title?: string
  onChange?: (checked: boolean) => void
  className?: string
}

/** 开关：真实控件是 `<button role="switch" aria-checked>`，可访问名字只来自 `label`。 */
export function Switch({ label, checked, disabled, title, onChange, className }: SwitchProps) {
  return createElement(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked === true,
      'aria-label': label,
      title,
      disabled,
      className,
      'data-stub': 'switch',
      onClick: () => { onChange?.(checked !== true) },
    },
  )
}

interface StateDotProps {
  state: string
  size?: number
  className?: string
  appearance?: 'dot' | 'step'
}

/** 状态点：真实控件是装饰性的（aria-hidden），颜色由 data-state 决定。 */
export function StateDot({ state, size, className, appearance }: StateDotProps) {
  return createElement('span', {
    'data-stub': 'state-dot',
    'data-state': state,
    'data-size': size,
    'data-appearance': appearance,
    'aria-hidden': true,
    className,
  })
}

interface SettingsFormLabels {
  unavailable?: string
  readOnly?: string
  saveFailed?: string
  save?: string
  saving?: string
}

interface SettingsFormState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

interface SettingsFormProps {
  labels: SettingsFormLabels
  state: SettingsFormState
  onSave: () => void
  onDiscard?: () => void
  children?: ReactNode
  className?: string
}

/**
 * 设置表单外框：命名空间不可用时只说一句；没有 Save/Discard 之外的入口，也不画 Discard 按钮
 * ——真实控件靠卸载时丢弃草稿，界面上的「放弃」只属于离开这一页。
 */
export function SettingsForm({ labels, state, onSave, onDiscard, children, className }: SettingsFormProps) {
  const discard = useRef(onDiscard)
  discard.current = onDiscard
  useEffect(() => () => { discard.current?.() }, [])
  if (!state.available) return createElement('p', { role: 'status', 'data-stub': 'settings-form-unavailable' }, labels.unavailable)
  const blocked = !state.dirty || state.invalid || state.saving
  return createElement(
    'div',
    { className, 'data-stub': 'settings-form' },
    state.writable ? null : createElement('p', { role: 'status' }, labels.readOnly),
    children,
    createElement(
      'div',
      { 'data-stub': 'settings-form-actions' },
      state.failed === true ? createElement('p', { role: 'status' }, labels.saveFailed) : null,
      createElement('button', { type: 'button', disabled: blocked, onClick: onSave }, state.saving ? labels.saving : labels.save),
    ),
  )
}

/** 管理弹窗层级：打开时登记一层，关闭或卸载时撤掉；关闭回调由 `closeTopModal` 调用。 */
export function useModalLayer(_ref: Ref<HTMLElement>, open: boolean, onDismiss?: () => void): void {
  useEffect(() => {
    if (!open) return undefined
    const layer = { dismiss: (): void => { onDismiss?.() } }
    layers.push(layer)
    return () => {
      const index = layers.indexOf(layer)
      if (index >= 0) layers.splice(index, 1)
    }
  }, [open, onDismiss])
}
