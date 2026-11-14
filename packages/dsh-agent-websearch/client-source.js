import TYPERT_REMOTE from '@tnzzzhlp/dsh-agent-websearch/remote'
import { mountModelsRemote } from './lib/client-models-remote.js'

window.__ModuleLoader__.load({
  id: '@tnzzzhlp/dsh-agent-websearch',
  factory(require) {
const React = require('react')
const h = React.createElement
const namespace = 'agentWebsearch'
const path = ['providers', 'agy', 'model']
const dictionaries = {
  en: {
    model: 'agy model', inherit: 'Use inherited value', inheritModel: 'Inherited', missingModel: 'Not in the available list', save: 'Save', saving: 'Saving...', saved: 'Saved.',
    discard: 'Discard changes', loading: 'Loading settings...', loadingModels: 'Loading models...',
    modelsFailed: 'Could not load models.', retry: 'Retry', empty: 'No models available.', manual: 'Model ID',
    failed: 'Could not save. Discard changes and try again if the configuration changed elsewhere.',
    readOnly: 'Settings are read-only.', unavailable: 'This plugin cannot be configured right now.',
    modelsCliMissing: 'The agy CLI was not found. Install it or configure its path.',
    modelsLogin: 'agy is not logged in. Sign in with the agy CLI or configure its login source.',
    modelsTimeout: 'The agy model request timed out.', modelsExit: 'The agy model command failed.',
    modelsOutput: 'The agy model command returned an invalid or oversized list.',
    modelsCancelled: 'The request was cancelled.', modelsBadRequest: 'The model request was invalid.',
    modelsUnknown: 'The model service could not complete the request.', modelsErrorCode: 'Error code',
  },
  zh: {
    model: 'agy 模型', inherit: '使用继承值', inheritModel: '继承', missingModel: '不在可用列表中', save: '保存', saving: '保存中...', saved: '已保存。',
    discard: '放弃更改', loading: '正在加载设置...', loadingModels: '正在加载模型...',
    modelsFailed: '无法加载模型。', retry: '重试', empty: '没有可用模型。', manual: '模型 ID',
    failed: '无法保存。如果配置已在其他位置更改，请放弃更改后重试。',
    readOnly: '设置为只读。', unavailable: '当前无法配置此插件。',
    modelsCliMissing: '找不到 agy CLI。请安装它或配置其路径。',
    modelsLogin: 'agy 尚未登录。请使用 agy CLI 登录或配置登录来源。',
    modelsTimeout: '获取 agy 模型超时。', modelsExit: 'agy 模型命令执行失败。',
    modelsOutput: 'agy 模型命令返回了无效或过大的列表。',
    modelsCancelled: '请求已取消。', modelsBadRequest: '模型请求无效。',
    modelsUnknown: '模型服务无法完成请求。', modelsErrorCode: '错误代码',
  },
}

function modelErrorKey(error) {
  if (error?.isDSHRemoteError !== true) return 'modelsUnknown'
  if (error.code === 'gateway/cancelled') return 'modelsCancelled'
  if (error.code === 'gateway/bad-request') return 'modelsBadRequest'
  const message = error.message
  if (message === '[dsh-agent-websearch] agy provider is not available: the agy CLI was not found; install agy, add it to PATH, set AGY_BIN, or set providers.agy.agyPath' ||
      message === '[dsh-agent-websearch] agy provider is not available: the agy CLI disappeared from PATH') return 'modelsCliMissing'
  if (message === '[dsh-agent-websearch] agy provider is not available: agy is not logged in on this machine; run the agy CLI once to log in, or set providers.agy.sourceHome to a HOME directory that contains the agy login' ||
      message === '[dsh-agent-websearch] agy is not logged in on this machine') return 'modelsLogin'
  if (message === '[dsh-agent-websearch] agy models timed out after 30s') return 'modelsTimeout'
  if (typeof message === 'string' && /^\[dsh-agent-websearch\] agy models exited with code (?:\d+|null)$/.test(message)) return 'modelsExit'
  if (message === '[dsh-agent-websearch] agy models output exceeded the size limit' ||
      message === '[dsh-agent-websearch] agy models returned an invalid model list' ||
      message === '[dsh-agent-websearch] agy models returned duplicate model ids') return 'modelsOutput'
  return 'modelsUnknown'
}

const controlStyle = {
  padding: '8px 10px', color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6, font: 'inherit',
}

return {
  inject: ['slots', 'locale', 'configForms', 'remote'],
  apply(ctx) {
  const form = ctx.configForms.get('agent-websearch')
  let mounted
  let disposed = false
  let unmount
  ctx.effect(() => async () => { disposed = true; await unmount?.() })
  ctx.effect(() => ctx.locale.register(namespace, dictionaries))

  async function getModels(signal) {
    if (!mounted) {
      mounted = mountModelsRemote(ctx, TYPERT_REMOTE).then(async remote => {
        if (disposed) await remote.dispose()
        else unmount = () => remote.dispose()
        return remote
      }).catch(error => {
        mounted = undefined
        throw error
      })
    }
    const remote = await mounted
    if (signal.aborted || disposed) return []
    const result = await remote.listModels(signal)
    if (!result.ok) throw result.error
    return result.value.models
  }

  function ModelForm({ t }) {
    const snapshot = React.useSyncExternalStore(
      React.useCallback(listener => form.subscribe(listener), []),
      React.useCallback(() => form.getSnapshot(), []),
    )
    const value = snapshot.user?.providers?.agy?.model ?? ''
    const [draft, setDraft] = React.useState(null)
    const [revision, setRevision] = React.useState(undefined)
    const [saving, setSaving] = React.useState(false)
    const [failed, setFailed] = React.useState(false)
    const [saved, setSaved] = React.useState(false)
    const [models, setModels] = React.useState([])
    const [modelsStatus, setModelsStatus] = React.useState('loading')
    const [modelsError, setModelsError] = React.useState('modelsUnknown')
    const [modelsErrorCode, setModelsErrorCode] = React.useState('')
    const [attempt, setAttempt] = React.useState(0)
    const text = draft === null ? value : draft

    React.useEffect(() => {
      const controller = new AbortController()
      setModelsStatus('loading')
      setModelsError('modelsUnknown')
      setModelsErrorCode('')
      getModels(controller.signal).then(list => {
        if (controller.signal.aborted) return
        setModels(list)
        setModelsStatus('ready')
      }, error => {
        if (!controller.signal.aborted) {
          setModelsError(modelErrorKey(error))
          setModelsErrorCode(error?.isDSHRemoteError === true && typeof error.code === 'string' && /^[a-z][a-z0-9-]*\/[a-z0-9-]+$/.test(error.code) ? error.code : 'client-error')
          setModelsStatus('failed')
        }
      })
      return () => controller.abort()
    }, [attempt])

    async function save(event) {
      event.preventDefault()
      if (saving || draft === null) return
      setSaving(true)
      setFailed(false)
      setSaved(false)
      try {
        const ok = await form.mutate([draft ? { op: 'set', path, value: draft } : { op: 'unset', path }], revision)
        if (ok) {
          setDraft(null)
          setSaved(true)
        } else setFailed(true)
      } catch {
        setFailed(true)
      } finally {
        setSaving(false)
      }
    }

    if (snapshot.status !== 'ready') return h('p', { role: 'status' }, t(snapshot.status === 'loading' ? 'loading' : 'unavailable'))
    const currentMissing = text && !models.some(model => model.id === text)
    return h('form', { onSubmit: save, style: { display: 'grid', gap: 8, maxWidth: 480, color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px' } },
      h('label', { htmlFor: 'agent-websearch-model' }, t('model')),
      h('select', {
        id: 'agent-websearch-model', value: text,
        disabled: !snapshot.writable || saving,
        onChange: event => {
          if (draft === null) setRevision(snapshot.revision)
          setDraft(event.target.value)
          setFailed(false)
          setSaved(false)
        },
        style: controlStyle,
      },
      h('option', { value: '' }, snapshot.base?.providers?.agy?.model ? `${t('inheritModel')}: ${snapshot.base.providers.agy.model}` : t('inherit')),
      currentMissing && h('option', { value: text }, modelsStatus === 'ready' ? `${text} (${t('missingModel')})` : text),
      models.filter(model => model.id).map(model => h('option', { key: model.id, value: model.id }, model.name || model.id))),
      modelsStatus === 'loading' && h('p', { role: 'status' }, t('loadingModels')),
      modelsStatus === 'failed' && h('div', null,
        h('span', { role: 'alert' }, t('modelsFailed'), ' ', t(modelsError), modelsErrorCode && ` (${t('modelsErrorCode')}: ${modelsErrorCode})`), ' ',
        h('button', { type: 'button', onClick: () => setAttempt(value => value + 1), style: controlStyle }, t('retry')),
        h('label', { htmlFor: 'agent-websearch-manual-model', style: { display: 'block' } }, t('manual')),
        h('input', { id: 'agent-websearch-manual-model', value: text, disabled: !snapshot.writable || saving, style: controlStyle,
          onChange: event => {
            if (draft === null) setRevision(snapshot.revision)
            setDraft(event.target.value)
            setFailed(false)
            setSaved(false)
          },
        })),
      modelsStatus === 'ready' && models.length === 0 && h('p', { role: 'status' }, t('empty')),
      !snapshot.writable && h('p', null, t('readOnly')),
      failed && h('p', { role: 'alert' }, t('failed')),
      saved && h('p', { role: 'status' }, t('saved')),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('button', { type: 'submit', disabled: !snapshot.writable || saving || draft === null, style: controlStyle }, t(saving ? 'saving' : 'save')),
        draft !== null && h('button', {
          type: 'button', disabled: saving,
          onClick: () => { setDraft(null); setFailed(false); setSaved(false) }, style: controlStyle,
        }, t('discard')),
      ),
    )
  }
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: '@tnzzzhlp/dsh-agent-websearch', locale: namespace,
  }, ModelForm))
  },
}
  },
})
