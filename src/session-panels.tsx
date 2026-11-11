/** @jsxImportSource @stencil-hq/tern */
import { translate } from './i18n';
import { html } from '@stencil-hq/tern';
import { basename } from 'node:path';
import type { Controller } from './controller';
import type { Draft } from './draft';

export function modelName(c: Controller, model?: string) {
  return model ? c.models.find(m => m.model === model)?.displayName ?? model : 'Use Codex default';
}
const effortName = (value: string) => ({ default: 'Default', none: 'None', minimal: 'Minimal', low: 'Low',
  medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' }[value] ?? value);
const pathLabel = (path: string) => process.env.HOME && path.startsWith(process.env.HOME + '/')
  ? '~' + path.slice(process.env.HOME.length) : path;
const row = (label: string, value: string, mono = false) => <html.div class="ct-detail-row">
  <html.span class="ct-detail-label">{label}</html.span>
  <html.span class={`ct-detail-value${mono ? ' ct-mono' : ''}`}>{value}</html.span>
</html.div>;

export function SessionDetails({ c, chooseModel, chooseEffort, chooseDefault, close }: {
  c: Controller; chooseModel: () => void; chooseEffort: () => void; chooseDefault: () => void; close: () => void;
}) {
  const t = (text: string) => translate(c.preferences.language, text);
  const detailRow = (label: string, value: string, mono = false) => row(t(label), t(value), mono);
  const access = c.effective?.sandbox?.type;
  const policy = c.effective?.approvalPolicy;
  const approvals = policy === 'on-request' ? 'When needed' : policy === 'untrusted' ? 'Untrusted commands'
    : policy === 'never' ? 'Never ask' : typeof policy === 'object' ? 'Custom rules' : 'Default';
  const reviewer = c.effective?.approvalsReviewer;
  const notices = c.notices.filter(n => !n.error);
  return <>
    <html.div class="ct-dialog-hero">
      <html.div class="ct-dialog-icon"><icon name="message" /></html.div>
      <html.div class="ct-dialog-heading">
        <html.div class="ct-dialog-title">{(c.thread?.name || c.thread?.preview || 'New session').replace(/\s+/g, ' ').slice(0, 120)}</html.div>
        <html.div class="ct-dialog-subtitle">{basename(c.cwd)} · {c.account}</html.div>
      </html.div>
      <html.span class="ct-session-state">{c.connection !== 'ready' ? t("Disconnected") : c.activeTurn ? t("Working") : t("Ready")}</html.span>
    </html.div>
    <html.div class="ct-detail-summary">
      <html.button class="ct-detail-card" aria={t("Change session model")} attrs={{ 'aria-disabled': c.busy }} onClick={c.busy ? undefined : chooseModel}>
        <html.span class="ct-card-label"><icon name="model" />{t("Model")}</html.span>
        <html.span class="ct-card-value">{modelName(c, c.model)}</html.span>
        <html.span class="ct-card-hint">{c.busy ? t("Current session") : t("Change model")}<icon name="chev-r" /></html.span>
      </html.button>
      <html.button class="ct-detail-card" aria={t("Change session reasoning")} attrs={{ 'aria-disabled': c.busy }} onClick={c.busy ? undefined : chooseEffort}>
        <html.span class="ct-card-label"><icon name="brain" />{t("Reasoning")}</html.span>
        <html.span class="ct-card-value">{t(effortName(c.effort))}</html.span>
        <html.span class="ct-card-hint">{c.busy ? t("Current session") : t("Change effort")}<icon name="chev-r" /></html.span>
      </html.button>
    </html.div>
    <html.div class="ct-detail-facts">
      {detailRow('Workspace', pathLabel(c.cwd))}
      {detailRow('File access', access === 'workspaceWrite' ? 'Workspace and allowed folders' : access === 'readOnly' ? 'Read only'
        : access === 'dangerFullAccess' ? 'Full access' : access === 'externalSandbox' ? 'Managed externally' : 'Loading…')}
      {detailRow('Approvals', t(approvals) + (reviewer === 'auto_review' || reviewer === 'guardian_subagent' ? t(' · Automatic review') : reviewer === 'user' ? t(' · Ask you') : ''))}
    </html.div>
    <html.button class="ct-default-model" aria={t("New session model")} onClick={chooseDefault}>
      <icon name="plus" /><html.div class="ct-default-copy"><html.span class="ct-card-label">{t("New session model")}</html.span>
        <html.span class="ct-default-value">{c.newSessionModel ? modelName(c, c.newSessionModel) : t('Use Codex default')}</html.span>
        <html.span class="ct-card-hint">{t("Used for new sessions in every workspace")}</html.span></html.div><icon name="chev-r" />
    </html.button>
    <section key="technical" role="ct.details.technical" head={t("Technical details")} collapsible collapsed>
      <html.div class="ct-detail-facts">
        {detailRow('Client', 'Codex × Tern 0.1.0')}
        {detailRow('Session ID', c.thread?.id ?? 'Not created', true)}
        {detailRow('Backend', c.rpc.options?.binary ?? process.env.CODEX_BINARY ?? 'codex', true)}
      </html.div>
      <section head={t("Diagnostics")} collapsible collapsed><code text={c.diagnostics.join('\n').slice(-12000) || t("No diagnostics.")} lang="text" wrap /></section>
    </section>
    {!!notices.length && <section key="notices" role="ct.details.notices" head={`Notices · ${notices.length}`} collapsible collapsed>
      {notices.map(n => <text key={n.id} text={n.text} />)}
    </section>}
    <html.div class="ct-dialog-footer"><html.span class="ct-footer-hint">{t("Esc to close")}</html.span>
      <html.button class="ct-button" aria={t("Close details")} onClick={close}>{t("Done")}</html.button></html.div>
  </>;
}

export function WorkspaceForm({ c, draft, path, error, opening, edit, focus, browse, chooseDefault, submit, close }: {
  c: Controller; draft: Draft; path: string; error: string; opening: boolean;
  edit: () => void; focus: () => void; browse: () => void; chooseDefault: () => void; submit: () => void; close: () => void;
}) {
  const t = (text: string) => translate(c.preferences.language, text);
  return <>
    <html.div class="ct-dialog-intro">{t("Choose where your next session works.")}</html.div>
    <html.div class="ct-workspace-preview"><html.div class="ct-dialog-icon"><icon name="folder-open" /></html.div>
      <html.div class="ct-dialog-heading"><html.div class="ct-dialog-title">{basename(path) || path}</html.div>
        <html.div class="ct-workspace-fullpath">{pathLabel(path)}</html.div></html.div></html.div>
    <html.div class="ct-field-heading"><html.span>{t("Folder path")}</html.span>
      <html.button class="ct-browse" aria={t("Browse folders")} attrs={{ 'aria-disabled': opening }} onClick={opening ? undefined : browse}>
        <icon name="folder" />{t("Browse")}</html.button></html.div>
    <input key="field" role="ct.workspace.path" aria={t("Workspace folder")} text={draft.text} cursor={draft.cursor} anchor={draft.anchor}
      placeholder={t("Paste or type a folder path")} onEdit={e => { if (!opening) { draft.nativeEdit(e); edit(); } }}
      onUndo={() => { if (!opening) { draft.undo(); edit(); } }} onFocus={focus} />
    {error && <html.div class="ct-field-error" role="ct.workspace.error"><icon name="warn" />{error}</html.div>}
    <html.button class="ct-default-model" aria={t("New session model")} attrs={{ 'aria-disabled': opening }} onClick={opening ? undefined : chooseDefault}>
      <icon name="model" /><html.div class="ct-default-copy"><html.span class="ct-card-label">{t("New session model")}</html.span>
        <html.span class="ct-default-value">{c.newSessionModel ? modelName(c, c.newSessionModel) : t('Use Codex default')}</html.span></html.div><icon name="chev-r" />
    </html.button>
    <html.div class="ct-dialog-footer"><html.span class="ct-footer-hint">{t("Current sessions keep running")}</html.span>
      <html.button class="ct-button" aria={t("Cancel workspace")} onClick={close}>{t("Cancel")}</html.button>
      <html.button class="ct-button ct-primary" aria={t("Create session")} attrs={{ 'aria-disabled': opening || !draft.text.trim() }}
        onClick={opening || !draft.text.trim() ? undefined : submit}>{opening ? t("Opening…") : t("Create session")}</html.button></html.div>
  </>;
}
