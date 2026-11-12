/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的测试替身。
 *
 * 真实包是一个大控件库：它的产物直接 import 了 shiki、katex、micromark、simple-icons 等一整套渲染
 * 依赖（却没有在自己的 package.json 里声明）。本包的界面只用它的四个入口——按钮、勾选框、设置表单
 * 外框，以及「关掉最上层弹窗」这两个函数——为一次测试渲染把整套代码编辑/图标栈装进开发依赖并不划算。
 *
 * 替身只保证**语义**：可访问名字、禁用状态、勾选与点击都照真实控件的行为走；外观不参与断言。
 * 官方控件自身的渲染由宿主负责，本包测的是自己那一层接线。
 */
import type { CSSProperties, ChangeEvent, ReactNode, Ref } from 'react'
import { createElement, useEffect } from 'react'

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

interface CheckboxProps {
  label?: ReactNode
  checked?: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
  className?: string
}

/** 带文字的勾选框：可访问名字来自 `<label>`，与真实控件一致。 */
export function Checkbox({ label, checked, disabled, onChange, className }: CheckboxProps) {
  return createElement(
    'label',
    { className, 'data-stub': 'checkbox' },
    createElement('input', {
      type: 'checkbox',
      checked: checked === true,
      disabled,
      onChange: (event: ChangeEvent<HTMLInputElement>) => { onChange?.(event.currentTarget.checked) },
    }),
    label,
  )
}

interface SettingsFormLabels {
  unavailable?: string
  readOnly?: string
  saveFailed?: string
  save?: string
  saving?: string
  discard?: string
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

/** 设置表单外框：内容原样渲染，底部给一个 Save（状态不满足时禁用）与可选的 Discard。 */
export function SettingsForm({ labels, state, onSave, onDiscard, children, className }: SettingsFormProps) {
  const blocked = !state.available || !state.writable || state.invalid || state.saving
  return createElement(
    'div',
    { className, 'data-stub': 'settings-form' },
    children,
    createElement(
      'div',
      { 'data-stub': 'settings-form-actions' },
      createElement('button', { type: 'button', disabled: blocked, onClick: onSave }, state.saving ? labels.saving : labels.save),
      onDiscard === undefined ? null : createElement('button', { type: 'button', onClick: onDiscard }, labels.discard),
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
