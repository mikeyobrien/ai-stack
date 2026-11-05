window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-agent',
  factory(require) {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { MarkdownText, StateDot } = primitives;
    const h = React.createElement;
    const NS = 'sidebar-agent';
    const PANEL_ID = 'agent';
    const EN = {
      meta: {
        title: 'Agent',
        description: 'An always-on agent in the left sidebar. Its delegations are sessions in workspaces.',
      },
      panel: 'Agent',
      title: 'Agent',
      transcript: 'Conversation',
      loading: 'Starting Agent\u2026',
      offline: 'Offline',
      'error.start': 'The Agent could not start.',
      'error.read': 'Could not read the Agent.',
      'error.connecting': 'Connecting to the Agent\u2026',
      'error.send': 'Could not send the message.',
      'error.stop': 'Could not stop the turn.',
      'error.file': 'Could not read that file.',
      'error.fileSize': 'Files are limited to 10 MB.',
      'error.attach': 'Could not attach that file.',
      'error.imageType': 'Paste a PNG, JPEG, WebP, or GIF image.',
      'action.retry': 'Retry',
      'action.send': 'Send',
      'action.stop': 'Stop',
      'action.attach': 'Attach files',
      'action.remove': 'Remove {name}',
      'action.refresh': 'Refresh',
      'action.latest': 'Latest',
      'action.latestNew': 'Latest (new content)',
      'state.running': 'Running',
      'state.idle': 'Idle',
      'state.stopped': 'Stopped',
      report: 'Delegation report',
      'report.open': 'Show delegation report',
      'report.close': 'Hide delegation report',
      'report.done': 'Done',
      'report.stopped': 'Stopped',
      'report.failed': 'Failed',
      'report.blocked': 'Blocked',
      'report.body': 'Delegation report content',
      'report.interrupted': 'Interrupted',
      'report.stalled': 'Stalled',
      stalled: 'Stalled',
      'stalled.aria': 'Stalled delegation',
      earlier: 'Earlier messages omitted.',
      'tool.error': 'Failed',
      'tool.detail': 'Show tool result',
      'tool.result': 'Tool result',
      'tool.hide': 'Hide tool result',
      'activity.show': 'Show {count} actions',
      'activity.hide': 'Hide {count} actions',
      'activity.failed': '{count} failed',
      'activity.body': 'Activity details',
      delegated: 'Delegated',
      'delegated.aria': 'Delegated session',
      placeholder: 'Message',
      'menu.model': 'Model',
      'menu.effort': 'Thinking',
      'effort.default': 'Default',
      'md.copy': 'Copy',
      'md.copied': 'Copied',
      'md.code': 'Code',
      'md.wrap': 'Wrap',
      'md.unwrap': 'Unwrap',
      'md.footnotes': 'Footnotes',
      'status.running': 'Agent running',
      'status.stopped': 'Agent stopped',
      'status.reply': 'Reply complete',
      'settings.open': 'Settings',
      'settings.close': 'Close settings',
      'settings.loading': 'Loading settings\u2026',
      'settings.title': 'Title',
      'settings.cwd': 'Directory',
      'settings.model': 'Model',
      'settings.thinking': 'Thinking',
      'settings.save': 'Save',
      'settings.saved': 'Saved',
      'settings.error.read': 'Could not read settings.',
      'settings.error.save': 'Could not save settings.',
      'settings.telegram': 'Telegram',
      'settings.telegram.status': 'Status',
      'settings.telegram.target': 'Target',
      'settings.telegram.binding': 'Binding',
      'settings.telegram.off': 'Off',
      'settings.telegram.inactive': 'Inactive',
      'settings.telegram.ready': 'On',
      'settings.telegram.error': 'Error',
      'settings.telegram.none': 'None',
      'settings.telegram.dm': 'Private DM',
      'settings.telegram.adopt': 'Adopt',
      'settings.telegram.adopted': 'Adopted',
      'settings.error.adopt': 'Could not adopt that DM.',
      'settings.agent': 'Agent',
    };
    const ID = '@local/dsh-sidebar-agent';
    const codec = { mode: 'strict', typeSymbol: ID + '#JSON', create: () => ({ parse: (value) => value }) };
    function contribution() {
      return { package: ID, descriptors: [
        { id: ID + '#status', service: 'agent', namespace: 'agent', method: 'status',
          invocation: { kind: 'direct' }, parameters: [], result: codec },
        { id: ID + '#catalog', service: 'agent', namespace: 'agent', method: 'catalog',
          invocation: { kind: 'direct' }, parameters: [], result: codec },
        { id: ID + '#chat', service: 'agent', namespace: 'agent', method: 'chat',
          invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
        { id: ID + '#setModel', service: 'agent', namespace: 'agent', method: 'setModel',
          invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
        { id: ID + '#settings', service: 'agent', namespace: 'agent', method: 'settings',
          invocation: { kind: 'direct' }, parameters: [], result: codec },
        { id: ID + '#saveSettings', service: 'agent', namespace: 'agent', method: 'saveSettings',
          invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
        { id: ID + '#telegramAdopt', service: 'agent', namespace: 'agent', method: 'telegramAdopt',
          invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
        { id: ID + '#agentStatus', service: 'agent', namespace: 'agent', method: 'agentStatus',
          invocation: { kind: 'direct' }, parameters: [], result: codec },
        { id: ID + '#deploymentCallback', service: 'agent', namespace: 'agent', method: 'deploymentCallback',
          invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
        { id: ID + '#image', service: 'agent', namespace: 'agent', method: 'image',
          invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
        { id: ID + '#delegated', service: 'agent', namespace: 'agent', method: 'delegated',
          invocation: { kind: 'direct' }, parameters: [], result: codec },
        { id: ID + '#stop', service: 'agent', namespace: 'agent', method: 'stop',
          invocation: { kind: 'direct' }, parameters: [], result: codec },
      ] };
    }

    function useTranslate(ctx) {
      const [snapshot, setSnapshot] = React.useState(ctx.locale.getSnapshot());
      React.useEffect(() => ctx.locale.subscribe(() => setSnapshot(ctx.locale.getSnapshot())), [ctx]);
      return React.useMemo(() => {
        const t = ctx.locale.bind(NS);
        return (key, values) => {
          void snapshot;
          return values === undefined ? t(key) : t(key, values);
        };
      }, [ctx, snapshot]);
    }

    // The panel is the Agent's conversation surface. A narrow, centered column
    // keeps prose readable in a maximized 1000px panel; the surrounding width
    // stays available to code and tables, which scroll inside their own block.
    const CSS = `
.sa-page{--sa-chat-content-width:clamp(680px,64%,920px);box-sizing:border-box;height:100%;display:flex;flex-direction:column;position:relative;min-height:0;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;
  --sa-md-base:14px;--sa-md-line:24px;--sa-md-h1:21px;--sa-md-h1-line:30px;--sa-md-h2:19px;--sa-md-h2-line:28px;
  --sa-md-h3:18px;--sa-md-h3-line:26px;--sa-md-table:13px;--sa-md-table-line:22px;--sa-md-code:12px;--sa-md-code-line:19px;
  --dsh-content-font-size:var(--sa-md-base);--dsh-content-font-delta:calc(var(--sa-md-base) - 14px);
  --dsh-code-font-size:var(--sa-md-code);--dsh-code-font-delta:calc(var(--sa-md-code) - 11px);
  --dsh-content-font-size-secondary:var(--sa-md-table);--dsh-content-font-delta-secondary:calc(var(--sa-md-table) - 13px);
  --dsw-font-markdown-base:var(--sa-md-base) / var(--sa-md-line) var(--dsw-font-family);
  --dsw-font-markdown-base-strong:600 var(--sa-md-base) / var(--sa-md-line) var(--dsw-font-family);
  --dsw-font-markdown-h1:700 var(--sa-md-h1) / var(--sa-md-h1-line) var(--dsw-font-family);
  --dsw-font-markdown-h2:700 var(--sa-md-h2) / var(--sa-md-h2-line) var(--dsw-font-family);
  --dsw-font-markdown-h3:700 var(--sa-md-h3) / var(--sa-md-h3-line) var(--dsw-font-family);
  --dsw-font-markdown-h4:600 var(--sa-md-base) / var(--sa-md-line) var(--dsw-font-family);
  --dsw-font-markdown-table:var(--sa-md-table) / var(--sa-md-table-line) var(--dsw-font-family);
  --dsw-font-markdown-table-head:500 var(--sa-md-table) / var(--sa-md-table-line) var(--dsw-font-family);
  --dsw-font-markdown-code:var(--sa-md-code) / var(--sa-md-code-line) var(--ds-font-family-code);
  --dsw-font-markdown-code-block:var(--sa-md-code) / var(--sa-md-code-line) var(--ds-font-family-code)}
.sa-page :is(button,textarea):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sa-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);
  white-space:nowrap;border:0}
.sa-header{display:flex;align-items:center;gap:10px;padding:12px clamp(16px,4vw,28px);flex:none;
  border-bottom:0.5px solid var(--dsw-alias-border-l1);min-width:0}
.sa-title{margin:0;font-size:16px;font-weight:500;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-state{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;flex:none}
.sa-transcriptWrap{position:relative;flex:1;min-height:0;display:flex}
.sa-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
.sa-column{box-sizing:border-box;width:100%;max-width:calc(var(--sa-chat-content-width) + 40px);margin:0 auto;padding:20px 20px 14px;
  display:flex;flex-direction:column;gap:18px;min-width:0}
.sa-turn{min-width:0}
.sa-userRow{display:flex;justify-content:flex-end;min-width:0}
.sa-userBubble{max-width:min(84%,560px);padding:8px 12px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);
  border:0.5px solid var(--dsw-alias-border-l1);white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
.sa-assistant{font-size:14px;line-height:1.62;overflow-wrap:anywhere;min-width:0}
.sa-markdown{min-width:0;max-width:100%}
.sa-markdown :is(pre,table){max-width:100%}
.sa-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.sa-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:2px 8px;border-radius:10px;
  border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-chipRemove{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;
  font-size:14px;line-height:1;cursor:pointer;padding:6px;margin:-6px -6px -6px 0}
.sa-activity{min-width:0;max-width:100%}
.sa-activityHeader{display:flex;align-items:center;gap:7px;width:100%;min-height:32px;padding:2px 4px 2px 0;
  border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;
  line-height:20px;text-align:left;cursor:pointer;min-width:0;border-radius:6px}
.sa-activityHeader:hover{color:var(--dsw-alias-label-primary)}
.sa-activityBody{display:flex;flex-direction:column;gap:2px;margin:2px 0 2px 21px;padding-left:10px;
  border-left:1px solid var(--dsw-alias-border-l1)}
.sa-toolRow{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);
  font-size:12.5px;line-height:20px;min-width:0;max-width:100%}
.sa-toolItem{min-width:0;max-width:100%}
.sa-toolIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.sa-toolPhrase{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sa-count{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.sa-failed{color:var(--dsw-alias-state-error-primary);flex:none}
.sa-toolChevron{flex:none;min-width:28px;min-height:28px;border:none;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer;
  padding:0;border-radius:6px;display:inline-flex;align-items:center;justify-content:center}
.sa-toolChevron:hover{background:var(--dsw-alias-bg-layer-1)}
.sa-toolDetail{box-sizing:border-box;margin:0 0 4px 21px;max-width:100%;max-height:200px;overflow:auto;overscroll-behavior:contain;color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;border-left:1px solid var(--dsw-alias-border-l1);
  padding-left:10px}
.sa-report{min-width:0;max-width:100%;border-left:2px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);
  border-radius:8px;padding:2px 10px 2px 8px}
.sa-reportHeader{display:flex;align-items:center;gap:7px;width:100%;min-height:34px;padding:2px 0;border:none;
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;
  cursor:pointer;min-width:0;border-radius:6px}
.sa-reportTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sa-activityHeader .sa-toolChevron,.sa-reportHeader .sa-toolChevron{margin-left:auto}
.sa-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:999px;flex:none;
  border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;
  font-variant-numeric:tabular-nums}
.sa-badgeError{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sa-badgeDone{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.sa-badgeDone::before{content:"";width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}
.sa-badgeWarn{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.sa-badgeWarn::before{content:"";width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-state-warn-primary)}
.sa-badgeStalled{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.sa-badgeStalled::before{content:"";width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-state-warn-primary)}
.sa-pillStalled{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.sa-markStalled{color:var(--dsw-alias-state-warn-primary)}
.sa-pill{display:inline-flex;align-items:center;gap:5px;height:22px;width:max-content;max-width:100%;padding:0 8px 0 7px;border-radius:999px;
  border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px;white-space:nowrap}
.sa-pillIcon{display:inline-flex;color:var(--dsw-alias-brand-primary)}
.sa-mark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;
  color:var(--dsw-alias-brand-primary)}
.sa-reportBody{padding:0 8px 8px 0;min-width:0}
.sa-scrollRegion{box-sizing:border-box;max-height:28rem;max-height:min(50dvh,28rem);overflow-y:auto;overscroll-behavior:contain}
.sa-scroll,.sa-scrollRegion,.sa-toolDetail,.sa-menu{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.sa-scroll::-webkit-scrollbar,.sa-scrollRegion::-webkit-scrollbar,.sa-toolDetail::-webkit-scrollbar,.sa-menu::-webkit-scrollbar{width:8px;height:8px}
.sa-scroll::-webkit-scrollbar-thumb,.sa-scrollRegion::-webkit-scrollbar-thumb,.sa-toolDetail::-webkit-scrollbar-thumb,.sa-menu::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px}
.sa-scroll::-webkit-scrollbar-track,.sa-scrollRegion::-webkit-scrollbar-track,.sa-toolDetail::-webkit-scrollbar-track,.sa-menu::-webkit-scrollbar-track,.sa-scroll::-webkit-scrollbar-corner{background:transparent}
.sa-scrollRegion:focus-visible,.sa-toolDetail:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sa-reportMeta{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;margin:0 0 6px;
  overflow-wrap:anywhere}
.sa-muted{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}
.sa-failure{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:0}
.sa-jump{position:absolute;right:16px;bottom:12px;z-index:5;display:inline-flex;align-items:center;gap:5px;
  height:32px;padding:0 11px;border-radius:16px;border:0.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;
  cursor:pointer;box-shadow:0 2px 8px rgb(0 0 0 / 0.12)}
.sa-jump:hover{background:var(--dsw-alias-bg-layer-2)}
.sa-jumpDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-link, var(--dsw-alias-brand-primary));flex:none}
.sa-composer{flex:none;position:relative;padding:10px clamp(16px,4vw,28px) 14px;border-top:0.5px solid var(--dsw-alias-border-l1)}
.sa-composerColumn{position:relative;box-sizing:border-box;width:100%;max-width:var(--sa-chat-content-width);margin:0 auto;display:flex;flex-direction:column;gap:8px;min-width:0}
.sa-composerColumn.sa-dragging{outline:1px dashed var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:8px}
.sa-controls{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.sa-control{height:32px;padding:0 9px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none;max-width:100%}
.sa-control:hover{color:var(--dsw-alias-label-primary)}
.sa-model{max-width:min(210px,44vw)}
.sa-effort{max-width:120px}
.sa-spacer{flex:1 1 auto;min-width:0}
.sa-stop{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sa-inputRow{display:flex;align-items:flex-end;gap:8px;min-width:0}
.sa-attach{width:44px;height:44px;flex:none;border-radius:10px;border:0.5px solid var(--dsw-alias-border-l2);
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;align-items:center;
  justify-content:center;padding:0}
.sa-attach:hover{color:var(--dsw-alias-label-primary)}
.sa-input{flex:1;width:100%;min-width:0;min-height:40px;max-height:160px;resize:none;box-sizing:border-box;
  padding:9px 12px;border-radius:12px;border:0.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;
  line-height:22px;outline:none;overflow-y:auto}
.sa-input:focus{border-color:var(--dsw-alias-brand-primary)}
.sa-send{height:40px;flex:none;padding:0 15px;border-radius:20px;border:none;
  background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);font:inherit;
  font-size:13px;cursor:pointer}
.sa-sendDisabled{opacity:0.5;cursor:default}
.sa-menu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:41;
  width:min(320px,100%);max-height:min(56vh,380px);overflow:auto;box-sizing:border-box;padding:6px;
  border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);
  box-shadow:0 8px 28px rgb(0 0 0 / 0.18)}
.sa-menu:focus{outline:none}
.sa-menu:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sa-menuLabel{color:var(--dsw-alias-label-secondary);font-size:11px;padding:6px 8px 2px}
.sa-menuGroup{color:var(--dsw-alias-label-secondary);font-size:11px;padding:8px 8px 2px}
.sa-menuItem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border-radius:8px;border:none;
  background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.sa-menuItem:hover{background:var(--dsw-alias-bg-layer-2)}
.sa-menuItemActive{background:var(--dsw-alias-bg-layer-2)}
.sa-menuCheck{margin-left:auto;color:var(--dsw-alias-brand-primary)}
.sa-menuEfforts{display:flex;flex-wrap:wrap;gap:6px;padding:4px 8px 8px}
.sa-effortChip{height:28px;padding:0 10px;border-radius:14px;border:0.5px solid var(--dsw-alias-border-l2);
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.sa-effortChip:hover{background:var(--dsw-alias-bg-layer-2)}
.sa-effortChipActive{background:var(--dsw-alias-bg-layer-2)}
.sa-backdrop{position:fixed;inset:0;z-index:40}
.sa-centered{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
  height:100%;color:var(--dsw-alias-label-secondary);font-size:13px;padding:24px;text-align:center}
.sa-button{height:32px;padding:0 12px;border-radius:16px;border:0.5px solid var(--dsw-alias-border-l2);
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.sa-button:hover{background:var(--dsw-alias-bg-layer-1)}
.sa-body{position:relative;flex:1;min-height:0;display:flex}
.sa-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.sa-headerActions{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none;min-width:0}
.sa-iconButton{width:auto;min-width:32px;height:32px;flex:none;border-radius:8px;border:none;
  background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;
  justify-content:center;gap:6px;cursor:pointer;padding:0 8px}
.sa-iconLabel{display:none;font-size:12px;line-height:1}
.sa-iconButton:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sa-side{position:absolute;inset:0 0 0 auto;z-index:31;width:min(320px,100%);box-sizing:border-box;
  overflow-y:auto;overscroll-behavior:contain;background:var(--dsw-alias-bg-base);
  border-left:0.5px solid var(--dsw-alias-border-l1);box-shadow:-8px 0 24px rgb(0 0 0 / 0.14);
  display:flex;flex-direction:column;outline:none}
.sa-side:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.sa-sideBackdrop{position:absolute;inset:0;z-index:30;background:rgb(0 0 0 / 0.3)}
.sa-sideHeader{display:flex;align-items:center;gap:8px;padding:10px 12px;
  border-bottom:0.5px solid var(--dsw-alias-border-l1);position:sticky;top:0;
  background:var(--dsw-alias-bg-base);z-index:1}
.sa-sideTitle{margin:0;font-size:14px;font-weight:500;line-height:24px;flex:1;min-width:0}
.sa-sideBody{display:flex;flex-direction:column;gap:12px;padding:12px;min-width:0}
.sa-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.sa-fieldLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.sa-fieldInput{box-sizing:border-box;width:100%;height:34px;padding:0 9px;border-radius:8px;
  border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;min-width:0}
.sa-fieldInput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sa-sideActions{display:flex;align-items:center;gap:10px}
.sa-sideActions .sa-button{height:34px}
.sa-saved{font-size:12px;color:var(--dsw-alias-label-secondary)}
.sa-telegram{display:flex;flex-direction:column;gap:8px;border-top:0.5px solid var(--dsw-alias-border-l1);
  padding-top:12px;min-width:0}
.sa-sideSectionTitle{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sa-metaRow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  font-size:13px;line-height:20px;min-width:0}
.sa-metaLabel{color:var(--dsw-alias-label-secondary);flex:none}
.sa-metaValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.sa-dmRow{display:flex;flex-direction:column;gap:6px;min-width:0}
.sa-dmRow .sa-button{align-self:flex-start}
@media (max-width:520px){
  .sa-page{font-size:16px;
    --sa-md-base:16px;--sa-md-line:26px;--sa-md-h1:23px;--sa-md-h1-line:32px;--sa-md-h2:21px;--sa-md-h2-line:30px;
    --sa-md-h3:20px;--sa-md-h3-line:28px;--sa-md-table:14px;--sa-md-table-line:23px;--sa-md-code:13px;--sa-md-code-line:20px}
  .sa-column{padding:14px 12px 10px;gap:16px}
  .sa-composer{padding:8px 12px calc(12px + env(safe-area-inset-bottom))}
  .sa-menu{left:0;width:min(320px,100%)}
  .sa-model{max-width:min(180px,40vw)}
  .sa-effort{max-width:96px}
  .sa-control,.sa-button,.sa-jump{height:40px}
  .sa-activityHeader,.sa-reportHeader{min-height:40px}
  .sa-toolChevron{min-width:36px;min-height:36px}
  .sa-menuItem{padding:11px 8px}
  .sa-effortChip{height:36px}
  .sa-input{font-size:16px}
  .sa-send{height:44px}
  .sa-iconButton{width:40px;height:40px}
  .sa-side{width:min(320px,100%)}
}
@media (max-width:360px){
  .sa-model{max-width:118px}
  .sa-effort{max-width:84px}
  .sa-control{padding:0 7px}
  .sa-send{padding:0 12px}
}
@media (min-width:900px){
  .sa-side{position:relative;inset:auto;z-index:auto;width:304px;flex:none;box-shadow:none}
  .sa-sideBackdrop{display:none}
  .sa-iconLabel{display:inline}
}
`;

    const SUPPORTED_IMAGE = /^image\/(?:png|jpe?g|webp|gif)$/i;
    const IMAGE_EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

    function pastedImageName(file) {
      if (typeof file.name === 'string' && file.name !== '') return file;
      const extension = IMAGE_EXTENSION[String(file.type).toLowerCase()] ?? 'png';
      return new File([file], `pasted-image.${extension}`, { type: file.type, lastModified: file.lastModified });
    }

    // Clipboard files are the source of truth; items are a fallback for
    // browsers that expose the image only there. Using both collections at
    // once is what double-attaches the same screenshot.
    function clipboardImageFiles(data) {
      const images = [];
      const add = (file) => {
        if (file === null || file === undefined) return;
        if (typeof file.type !== 'string' || !/^image\//i.test(file.type)) return;
        images.push(file);
      };
      for (const file of Array.from(data.files ?? [])) add(file);
      if (images.length === 0) {
        for (const item of Array.from(data.items ?? [])) {
          if (item.kind !== 'file') continue;
          add(typeof item.getAsFile === 'function' ? item.getAsFile() : null);
        }
      }
      const seen = new Set();
      return images.filter((file) => {
        if (seen.has(file)) return false;
        seen.add(file);
        return true;
      });
    }

    const imageCache = new Map();

    function ChatImage({ request, alt, image, style }) {
      const key = request?.path ?? request?.attachment?.attachmentId ?? '';
      const [url, setUrl] = React.useState(() => imageCache.get(key) ?? null);
      React.useEffect(() => {
        if (url !== null || key === '') return undefined;
        let cancelled = false;
        void (async () => {
          try {
            const result = await image(request);
            if (cancelled || !result.ok) return;
            const next = `data:${result.value.mediaType};base64,${result.value.base64}`;
            imageCache.set(key, next);
            setUrl(next);
          } catch {
            // A failed image read leaves the row without a picture.
          }
        })();
        return () => { cancelled = true; };
      }, [key]);
      return url === null ? null : h('img', { src: url, alt, style });
    }

    function ToolIcon({ name }) {
      const paths = name === 'bash' || name === 'terminal'
        ? [h('path', { key: 'a', d: 'M4 7l5 5-5 5' }), h('path', { key: 'b', d: 'M12 17h8' })]
        : name === 'read_image'
          ? [h('rect', { key: 'a', x: 3, y: 5, width: 18, height: 14, rx: 2 }),
            h('circle', { key: 'b', cx: 8, cy: 10, r: 1.5 }),
            h('path', { key: 'c', d: 'M21 15l-5-5-8 8' })]
          : name === 'read' || name === 'write' || name === 'edit'
            ? [h('path', { key: 'a', d: 'M6 3h8l4 4v14H6z' }), h('path', { key: 'b', d: 'M14 3v4h4' })]
            : name === 'delegate' || name === 'delegations' || name === 'steer_delegation' || name === 'stop_delegation'
              ? [h('rect', { key: 'a', x: 4, y: 7, width: 16, height: 12, rx: 3 }),
                h('path', { key: 'b', d: 'M12 7V4' }),
                h('circle', { key: 'c', cx: 9, cy: 12.5, r: 1, fill: 'currentColor', stroke: 'none' }),
                h('circle', { key: 'd', cx: 15, cy: 12.5, r: 1, fill: 'currentColor', stroke: 'none' })]
              : [h('rect', { key: 'a', x: 5, y: 5, width: 14, height: 14, rx: 3 })];
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, paths);
    }

    // Human names keep the collapsed activity line free of wire method ids and
    // raw JSON. Unknown tools are humanized rather than dumped.
    const TOOL_LABELS = {
      bash: 'Shell', terminal: 'Terminal', read: 'Read', write: 'Write', edit: 'Edit',
      read_image: 'Read image', glob: 'Find files', grep: 'Search', delegate: 'Delegate',
      delegations: 'List delegations', steer_delegation: 'Steer delegation', stop_delegation: 'Stop delegation',
      skill: 'Load skill', principle_read: 'Read principle', todo_write: 'Update plan',
      get_goal: 'Read goal', update_goal: 'Update goal', create_goal: 'Create goal',
      job_list: 'List jobs', job_output: 'Read job output', job_kill: 'Stop job',
      session_search: 'Search sessions', session_trace: 'Trace session', session_event_read: 'Read session event',
      web_search: 'Search web', web_fetch: 'Fetch page', present: 'Present file', workflow: 'Run workflow',
      subagent: 'Delegate to subagent', list_agents: 'List agents', interrupt_agent: 'Stop subagent',
      cordis_inspect_list: 'List DSH services', cordis_inspect_query: 'Inspect DSH service',
      schedule_create: 'Schedule reminder', schedule_list: 'List reminders', schedule_update: 'Update reminder',
      schedule_delete: 'Delete reminder', local_models: 'Check local models',
    };

    function humanToolName(name) {
      if (typeof name !== 'string' || name === '') return 'Tool';
      if (TOOL_LABELS[name] !== undefined) return TOOL_LABELS[name];
      const parts = name.split('__');
      const base = parts.length >= 3 ? parts.slice(2).join('__') : name;
      const words = base.replace(/[_-]+/g, ' ').trim();
      return words === '' ? 'Tool' : words.charAt(0).toUpperCase() + words.slice(1);
    }

    function humanSummary(name, summary) {
      if (typeof summary !== 'string') return '';
      const trimmed = summary.trim();
      if (trimmed === '' || trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('mcp__')) return '';
      if (name !== 'bash' && trimmed.length > 80) return '';
      return trimmed;
    }

    function toolPhrase(name, summary) {
      if (name === 'bash') {
        const command = humanSummary(name, summary);
        return command === '' ? 'Ran a command' : `Ran ${command}`;
      }
      if (name === 'read') {
        const file = humanSummary(name, summary);
        return file === '' ? 'Read a file' : `Read ${file}`;
      }
      if (name === 'read_image') return 'Read an image';
      if (name === 'write') {
        const file = humanSummary(name, summary);
        return file === '' ? 'Wrote a file' : `Wrote ${file}`;
      }
      if (name === 'edit') {
        const file = humanSummary(name, summary);
        return file === '' ? 'Edited a file' : `Edited ${file}`;
      }
      if (name === 'delegate') {
        const label = humanSummary(name, summary);
        return label === '' ? 'Delegated' : `Delegated ${label}`;
      }
      if (name === 'delegations') return 'Listed delegations';
      if (name === 'steer_delegation') return 'Steered a delegation';
      if (name === 'stop_delegation') return 'Stopped a delegation';
      if (name === 'skill') {
        const label = humanSummary(name, summary);
        return label === '' ? 'Loaded a skill' : `Loaded skill ${label}`;
      }
      if (name === 'principle_read') {
        const label = humanSummary(name, summary);
        return label === '' ? 'Read a principle' : `Read principle ${label}`;
      }
      if (name === 'grep') {
        const label = humanSummary(name, summary);
        return label === '' ? 'Searched files' : `Searched ${label}`;
      }
      if (name === 'glob') {
        const label = humanSummary(name, summary);
        return label === '' ? 'Found files' : `Found ${label}`;
      }
      return humanToolName(name);
    }

    const REPORT_HEADER = /^\[delegation (\S+) "([\s\S]*?)" in ([\s\S]*?) ended: ([a-z-]+)(?: at (\d+))?\]\s*/;
    const STALL_HEADER = /^\[delegation (\S+) "([\s\S]*?)" in ([\s\S]*?) stalled: ([\s\S]*?) at (\d+)\]\s*/;

    function parseReport(text) {
      const source = typeof text === 'string' ? text : '';
      const match = REPORT_HEADER.exec(source);
      if (match !== null) {
        return {
          header: {
            sessionId: match[1],
            title: match[2],
            workspace: match[3],
            outcome: match[4],
            ...(match[5] === undefined ? {} : { endedAt: Number(match[5]) }),
          },
          body: source.slice(match[0].length),
        };
      }
      const stalled = STALL_HEADER.exec(source);
      if (stalled === null) return { header: null, body: source };
      return {
        header: {
          sessionId: stalled[1],
          title: stalled[2],
          workspace: stalled[3],
          outcome: 'stalled',
          stalledAt: Number(stalled[5]),
        },
        body: source.slice(stalled[0].length),
      };
    }

    function outcomeLabel(outcome, t) {
      if (outcome === 'done') return t('report.done');
      if (outcome === 'stopped') return t('report.stopped');
      if (outcome === 'failed') return t('report.failed');
      if (outcome === 'blocked') return t('report.blocked');
      if (outcome === 'interrupted') return t('report.interrupted');
      if (outcome === 'stalled') return t('report.stalled');
      return typeof outcome === 'string' && outcome !== '' ? outcome : '';
    }

    function outcomeClass(outcome) {
      if (outcome === 'done') return 'sa-badge sa-badgeDone';
      if (outcome === 'failed') return 'sa-badge sa-badgeError';
      if (outcome === 'stalled') return 'sa-badge sa-badgeStalled';
      if (outcome === 'blocked' || outcome === 'interrupted') return 'sa-badge sa-badgeWarn';
      return 'sa-badge';
    }

    // Consecutive execution calls belong to one disclosure; everything else
    // keeps its transcript position. Grouping is presentation only.
    // A focused scroll region owns the keyboard until its content ends; at a
    // boundary, stop the key so the transcript does not scroll underneath it.
    function containScrollKeys(event) {
      if (event.target !== event.currentTarget) return;
      const element = event.currentTarget;
      const atTop = element.scrollTop <= 0;
      const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
      const key = event.key;
      const down = key === 'ArrowDown' || key === 'PageDown' || key === 'End' || (key === ' ' && event.shiftKey !== true);
      const up = key === 'ArrowUp' || key === 'PageUp' || key === 'Home' || (key === ' ' && event.shiftKey === true);
      if ((down && atBottom) || (up && atTop)) event.preventDefault();
    }

    function buildItems(messages) {
      const items = [];
      let group = null;
      for (const message of messages) {
        if (message.role === 'tool') {
          if (group === null) {
            group = { kind: 'tools', id: `tools:${message.id}`, tools: [] };
            items.push(group);
          }
          group.tools.push(message);
        } else {
          group = null;
          items.push({ kind: 'message', id: message.id, message });
        }
      }
      return items;
    }

    function delegatedSpinnerCss(ids, stalledIds = []) {
      const valid = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
      return [
        ...[...ids].filter(valid).map((id) => `[data-row-key="session:${id}"] svg[data-state="ongoing"]{color:var(--dsw-alias-link, var(--dsw-alias-brand-primary))}`),
        ...[...stalledIds].filter(valid).map((id) => `[data-row-key="session:${id}"] svg[data-state="ongoing"]{color:var(--dsw-alias-state-warn-primary)}`),
      ].join('\n');
    }

    function MarkdownBody({ text, streaming, labels }) {
      if (text === null || text === undefined || text === '') return null;
      return h('div', { className: 'sa-markdown' },
        h(MarkdownText, { text, streaming: streaming === true, labels }));
    }

    function ToolRow({ message, t, image, onToggle, nested }) {
      const [open, setOpen] = React.useState(false);
      const phrase = toolPhrase(message.name, message.summary);
      const detail = message.result;
      const detailId = `sa-tool-detail-${message.id}`;
      return h('div', { className: 'sa-toolItem', 'data-sa-item': '' },
        h('div', { className: 'sa-toolRow', style: nested ? { paddingLeft: 0 } : undefined },
          h('span', { className: 'sa-toolIcon' }, h(ToolIcon, { name: message.name })),
          h('span', { className: 'sa-toolPhrase' }, phrase),
          message.isError ? h('span', { className: 'sa-failed' }, t('tool.error')) : null,
          detail ? h('button', {
            type: 'button', className: 'sa-toolChevron',
            onClick: (event) => {
              const item = event.currentTarget.closest('[data-sa-item]');
              const change = () => setOpen((value) => !value);
              if (onToggle === undefined) change();
              else onToggle(item, change);
            },
            'aria-expanded': open,
            'aria-controls': open ? detailId : undefined,
            'aria-label': `${open ? t('tool.hide') : t('tool.detail')}: ${phrase}`,
          }, open ? '\u25be' : '\u25b8') : null),
        open && detail ? h('div', {
          id: detailId, className: 'sa-toolDetail', tabIndex: 0, role: 'region',
          'aria-label': `${t('tool.result')}: ${phrase}`, onKeyDown: containScrollKeys,
        }, detail) : null,
        message.image ? h(ChatImage, { request: message.image, alt: 'Read image', image, style: { display: 'block', maxWidth: '100%', maxHeight: 220, borderRadius: 8, objectFit: 'contain', margin: '4px 0 6px 21px' } }) : null);
    }

    function ActivityGroup({ tools, t, image, onToggle }) {
      const [open, setOpen] = React.useState(false);
      const failed = tools.filter((tool) => tool.isError === true).length;
      if (tools.length === 1) return h(ToolRow, { message: tools[0], t, image, onToggle, nested: true });
      const first = toolPhrase(tools[0].name, tools[0].summary);
      const bodyId = `sa-activity-body-${tools[0].id}`;
      return h('div', { className: 'sa-activity', 'data-sa-item': '' },
        h('button', {
          type: 'button', className: 'sa-activityHeader',
          'aria-expanded': open,
          'aria-controls': open ? bodyId : undefined,
          'aria-label': open
            ? t('activity.hide', { count: tools.length })
            : t('activity.show', { count: tools.length }),
          onClick: (event) => {
            const item = event.currentTarget.closest('[data-sa-item]');
            const change = () => setOpen((value) => !value);
            if (onToggle === undefined) change();
            else onToggle(item, change);
          },
        },
          h('span', { className: 'sa-toolIcon' }, h(ToolIcon, { name: tools[0].name })),
          h('span', { className: 'sa-toolPhrase' }, first),
          h('span', { className: 'sa-count' }, `+${tools.length - 1}`),
          failed > 0 ? h('span', { className: 'sa-failed' }, t('activity.failed', { count: failed })) : null,
          h('span', { className: 'sa-toolChevron', 'aria-hidden': true }, open ? '\u25be' : '\u25b8')),
        open ? h('div', {
          id: bodyId, className: 'sa-activityBody sa-scrollRegion', tabIndex: 0, role: 'region',
          'aria-label': t('activity.body'), onKeyDown: containScrollKeys,
        },
          tools.map((tool) => h(ToolRow, { key: tool.id, message: tool, t, image, onToggle, nested: true }))) : null);
    }

    function DelegationReport({ message, t, labels, onToggle }) {
      const [open, setOpen] = React.useState(false);
      const parsed = parseReport(message.text);
      const header = parsed.header;
      const title = header === null || header.title === '' ? t('report') : header.title;
      const outcome = header === null ? '' : outcomeLabel(header.outcome, t);
      const bodyId = `sa-report-body-${message.id}`;
      return h('div', { className: 'sa-report', 'data-sa-item': '' },
        h('button', {
          type: 'button', className: 'sa-reportHeader',
          'aria-expanded': open,
          'aria-controls': open ? bodyId : undefined,
          'aria-label': `${open ? t('report.close') : t('report.open')}: ${title}${outcome === '' ? '' : ` (${outcome})`}`,
          onClick: (event) => {
            const item = event.currentTarget.closest('[data-sa-item]');
            const change = () => setOpen((value) => !value);
            if (onToggle === undefined) change();
            else onToggle(item, change);
          },
        },
          h('span', { className: 'sa-toolIcon' }, h(DelegationGlyph, { size: 14 })),
          h('span', { className: 'sa-reportTitle', title }, title),
          outcome === '' ? null : h('span', { className: outcomeClass(header.outcome) }, outcome),
          h('span', { className: 'sa-toolChevron', 'aria-hidden': true }, open ? '\u25be' : '\u25b8')),
        open ? h('div', {
          id: bodyId, className: 'sa-reportBody sa-scrollRegion', tabIndex: 0, role: 'region',
          'aria-label': t('report.body'), onKeyDown: containScrollKeys,
        },
          header === null ? null : h('div', { className: 'sa-reportMeta' },
            [header.workspace, header.sessionId].join(' \u00b7 ')),
          h(MarkdownBody, { text: parsed.body, labels })) : null);
    }

    function MessageRow({ message, t, image, labels, onToggle }) {
      if (message.role === 'user') {
        if (message.source === 'delegation') {
          return h(DelegationReport, { message, t, labels, onToggle });
        }
        const attachments = message.attachments ?? [];
        return h('div', { className: 'sa-turn sa-userRow' },
          h('div', { className: 'sa-userBubble' },
            message.text ? h('div', { style: { whiteSpace: 'pre-wrap' } }, message.text) : null,
            attachments.length === 0 ? null : h('div', { className: 'sa-chips' },
              attachments.map((attachment, index) => attachment.kind === 'image'
                ? h(ChatImage, { key: index, request: { attachment: attachment.attachment }, alt: attachment.name, image, style: { display: 'block', maxWidth: 200, maxHeight: 140, borderRadius: 8, objectFit: 'contain', margin: '4px 0 0' } })
                : h('span', { key: index, className: 'sa-chip' }, attachment.name)))));
      }
      if (message.role === 'assistant') {
        return h('div', { className: 'sa-turn sa-assistant' },
          h(MarkdownBody, { text: message.text, labels }));
      }
      if (message.role === 'tool') return h(ToolRow, { message, t, image, onToggle });
      return null;
    }

    function modelOf(catalog, selection) {
      if (catalog === null || selection === null || selection === undefined) return null;
      for (const group of catalog.groups ?? []) {
        if (group.id !== selection.provider) continue;
        const model = group.models.find((entry) => entry.id === selection.model);
        if (model !== undefined) return { group, model };
      }
      return null;
    }

    function modelLabel(catalog, selection) {
      if (selection === null || selection === undefined) return '';
      const found = modelOf(catalog, selection);
      return found === null ? `${selection.provider}/${selection.model}` : found.model.name;
    }

    function effortLabel(catalog, selection, t) {
      if (selection === null || selection === undefined || selection.reasoningEffort === undefined) return t('effort.default');
      const found = modelOf(catalog, selection);
      const effort = found?.model.reasoning?.efforts?.find((entry) => entry.id === selection.reasoningEffort);
      return effort === undefined ? selection.reasoningEffort : effort.name;
    }

    function ModelMenu({ mode, catalog, selection, error, onModel, onEffort, t, menuRef, onClose }) {
      const found = modelOf(catalog, selection);
      const effortOnly = mode === 'effort';
      return h('div', {
        className: 'sa-menu', role: 'menu', tabIndex: -1, ref: menuRef,
        'aria-label': effortOnly ? t('menu.effort') : t('menu.model'),
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        },
      },
        effortOnly ? null : h('div', { className: 'sa-menuLabel' }, t('menu.model')),
        catalog === null ? h('div', { className: 'sa-menuLabel' }, t('loading')) : null,
        effortOnly ? null : (catalog?.groups ?? []).map((group) => h('div', { key: group.id },
          h('div', { className: 'sa-menuGroup' }, group.name),
          group.models.map((model) => {
            const active = selection !== null && selection !== undefined
              && selection.provider === group.id && selection.model === model.id;
            return h('button', {
              key: `${group.id}/${model.id}`, type: 'button', role: 'menuitemradio', 'aria-checked': active,
              className: active ? 'sa-menuItem sa-menuItemActive' : 'sa-menuItem',
              onClick: () => onModel(group.id, model.id),
            },
              h('span', null, model.name),
              active ? h('span', { className: 'sa-menuCheck', 'aria-hidden': true }, '\u2713') : null);
          }))),
        found?.model.reasoning === undefined || found?.model.reasoning === null ? null
          : h('div', null,
            h('div', { className: 'sa-menuLabel' }, t('menu.effort')),
            h('div', { className: 'sa-menuEfforts' },
              h('button', {
                type: 'button', role: 'menuitemradio', 'aria-checked': selection.reasoningEffort === undefined,
                className: selection.reasoningEffort === undefined ? 'sa-effortChip sa-effortChipActive' : 'sa-effortChip',
                onClick: () => onEffort(undefined),
              }, t('effort.default')),
              (found.model.reasoning.efforts ?? []).map((effort) => h('button', {
                key: effort.id, type: 'button', role: 'menuitemradio', 'aria-checked': selection.reasoningEffort === effort.id,
                className: selection.reasoningEffort === effort.id ? 'sa-effortChip sa-effortChipActive' : 'sa-effortChip',
                onClick: () => onEffort(effort.id),
              }, effort.name)))),
        error === null || error === undefined ? null : h('div', { className: 'sa-failure', role: 'alert' }, error));
    }

    const delegatedStore = { ids: new Set(), stalled: new Set(), listeners: new Set() };

    function useDelegated(sessionId) {
      const [, force] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        delegatedStore.listeners.add(force);
        return () => { delegatedStore.listeners.delete(force); };
      }, []);
      return delegatedStore.ids.has(sessionId);
    }

    function useStalled(sessionId) {
      const [, force] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        delegatedStore.listeners.add(force);
        return () => { delegatedStore.listeners.delete(force); };
      }, []);
      return delegatedStore.stalled.has(sessionId);
    }

    function DelegationGlyph({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
        h('circle', { cx: 3.5, cy: 8, r: 1.6 }),
        h('circle', { cx: 12.5, cy: 3.5, r: 1.6 }),
        h('circle', { cx: 12.5, cy: 12.5, r: 1.6 }),
        h('path', { d: 'M5 7.3 11 4.2' }),
        h('path', { d: 'M5 8.7 11 11.8' }));
    }

    function DelegationTag({ sessionId, useDelegated, useStalled = () => false, t }) {
      if (!useDelegated(sessionId)) return null;
      const stalled = useStalled(sessionId);
      return h('span', {
        className: stalled ? 'sa-pill sa-pillStalled' : 'sa-pill', role: 'note',
        'aria-label': stalled ? t('stalled.aria') : t('delegated.aria'),
        title: stalled ? t('stalled.aria') : t('delegated.aria'),
      },
        h('span', { className: 'sa-pillIcon' }, h(DelegationGlyph, { size: 13 })),
        h('span', null, stalled ? t('stalled') : t('delegated')));
    }

    function DelegationMark({ sessionId, useDelegated, useStalled = () => false, t }) {
      if (!useDelegated(sessionId)) return null;
      const stalled = useStalled(sessionId);
      return h('span', {
        className: stalled ? 'sa-mark sa-markStalled' : 'sa-mark', role: 'img',
        'aria-label': stalled ? t('stalled.aria') : t('delegated.aria'),
        title: stalled ? t('stalled') : t('delegated'),
      }, h(DelegationGlyph, { size: 14 }));
    }

    function Composer({
      t, draft, setDraft, files, attach, pasteClipboard, dropFiles, removeFile, send, stop, running, sending, sendError,
      selection, catalogData, catalogError, menuOpen, menuMode, openMenu, closeMenu,
      chooseModel, chooseEffort, inputRef, fileInputRef, menuRef, modelButtonRef, effortButtonRef,
    }) {
      const composing = React.useRef(false);
      const [dragging, setDragging] = React.useState(false);
      const dragOver = (event) => { event.preventDefault(); event.stopPropagation(); setDragging(true); };
      const dragLeave = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget?.contains?.(event.relatedTarget)) return;
        setDragging(false);
      };
      const drop = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        dropFiles(event);
      };
      const canSend = (draft.trim() !== '' || files.length > 0) && !sending;
      React.useLayoutEffect(() => {
        const input = inputRef.current;
        if (input === null) return;
        // The border pair is inside box-sizing:border-box but outside
        // clientHeight, so height = scrollHeight alone leaves a 2px phantom
        // overflow and a scrollbar on an empty composer.
        const borders = input.offsetHeight - input.clientHeight;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight + borders, 160)}px`;
      }, [draft, files.length]);
      const modelName = modelLabel(catalogData, selection);
      const effortName = effortLabel(catalogData, selection, t);
      return h('div', { className: 'sa-composer' },
        menuOpen ? h('div', { className: 'sa-backdrop', onClick: closeMenu, 'aria-hidden': true }) : null,
        h('div', {
          className: dragging ? 'sa-composerColumn sa-dragging' : 'sa-composerColumn',
          onDragOver: dragOver, onDragEnter: dragOver, onDragLeave: dragLeave, onDrop: drop,
        },
          menuOpen ? h(ModelMenu, {
            mode: menuMode, catalog: catalogData, selection, error: catalogError,
            onModel: chooseModel, onEffort: chooseEffort, t, menuRef, onClose: closeMenu,
          }) : null,
          sendError === null || sendError === undefined ? null : h('p', { className: 'sa-failure', role: 'alert' }, sendError),
          files.length === 0 ? null : h('div', { className: 'sa-chips' },
            files.map((file, index) => h('span', { key: `${file.name}:${index}`, className: 'sa-chip' },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, file.name),
              h('button', {
                type: 'button', className: 'sa-chipRemove', 'aria-label': t('action.remove', { name: file.name }),
                onClick: () => removeFile(index),
              }, '\u00d7')))),
          h('div', { className: 'sa-controls' },
            selection === null || selection === undefined ? null : h('button', {
              type: 'button', ref: modelButtonRef, className: 'sa-control sa-model',
              title: modelName, 'aria-haspopup': 'menu',
              'aria-expanded': menuOpen && menuMode === 'model',
              'aria-label': `${t('menu.model')}: ${modelName}`,
              onClick: () => openMenu('model'),
            }, modelName),
            selection === null || selection === undefined ? null : h('button', {
              type: 'button', ref: effortButtonRef, className: 'sa-control sa-effort',
              title: effortName, 'aria-haspopup': 'menu',
              'aria-expanded': menuOpen && menuMode === 'effort',
              'aria-label': `${t('menu.effort')}: ${effortName}`,
              onClick: () => openMenu('effort'),
            }, effortName),
            h('span', { className: 'sa-spacer' }),
            running ? h('button', { type: 'button', className: 'sa-control sa-stop', onClick: stop }, t('action.stop')) : null),
          h('div', { className: 'sa-inputRow' },
            h('button', {
              type: 'button', className: 'sa-attach', 'aria-label': t('action.attach'),
              onClick: () => fileInputRef.current?.click(),
            },
              h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
                strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
                h('path', { d: 'M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 18a2 2 0 0 1-3-3l7.5-7.5' }))),
            h('input', { type: 'file', multiple: true, ref: fileInputRef, style: { display: 'none' },
              onChange: (event) => void attach(event) }),
            h('textarea', {
              ref: inputRef, className: 'sa-input', rows: 1, value: draft, placeholder: t('placeholder'),
              'aria-label': t('placeholder'),
              onChange: (event) => setDraft(event.target.value),
              onPaste: pasteClipboard,
              onDragOver: dragOver, onDragEnter: dragOver, onDragLeave: dragLeave, onDrop: drop,
              onCompositionStart: () => { composing.current = true; },
              onCompositionEnd: () => { composing.current = false; },
              onKeyDown: (event) => {
                const native = event.nativeEvent;
                if (composing.current || native?.isComposing === true || event.keyCode === 229) return;
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                  return;
                }
                if (event.key === 'Escape' && running) {
                  event.preventDefault();
                  void stop();
                }
              },
            }),
            h('button', {
              type: 'button', className: canSend ? 'sa-send' : 'sa-send sa-sendDisabled',
              disabled: !canSend, onClick: () => void send(),
            }, t('action.send')))));
    }


    /** The editable form shape for one settings response. */
    function settingsFormOf(value) {
      const model = value?.values?.model ?? null;
      return {
        title: value?.values?.title ?? '',
        cwd: value?.values?.cwd ?? '',
        provider: model?.provider ?? '',
        model: model?.model ?? '',
        effort: model?.reasoningEffort ?? '',
      };
    }

    /**
     * Only changed fields are sent. A title/directory edit therefore never
     * restates (or resets) the composer-owned model choice.
     */
    function settingsPatchOf(form, initial) {
      if (form === null || initial === null) return null;
      const patch = {};
      if (form.title !== initial.title) patch.title = form.title;
      if (form.cwd !== initial.cwd) patch.cwd = form.cwd;
      const modelChanged = form.provider !== initial.provider || form.model !== initial.model;
      if (modelChanged) {
        patch.provider = form.provider;
        patch.model = form.model;
        patch.reasoningEffort = form.effort === '' ? null : form.effort;
      } else if (form.effort !== initial.effort) {
        patch.reasoningEffort = form.effort === '' ? null : form.effort;
      }
      return patch;
    }

    function telegramStateLabel(telegram, t) {
      const state = telegram?.state ?? 'off';
      if (state === 'ready') return t('settings.telegram.ready');
      if (state === 'inactive') return t('settings.telegram.inactive');
      if (state === 'error') return t('settings.telegram.error');
      return t('settings.telegram.off');
    }

    function SlidersIcon() {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true,
      },
        h('path', { key: 'a', d: 'M4 7h9' }),
        h('path', { key: 'b', d: 'M17 7h3' }),
        h('circle', { key: 'c', cx: 15, cy: 7, r: 2 }),
        h('path', { key: 'd', d: 'M4 17h3' }),
        h('path', { key: 'e', d: 'M11 17h9' }),
        h('circle', { key: 'f', cx: 7.5, cy: 17, r: 2 }));
    }

    // The Agent page owns this right-hand seat. It is not the shell's
    // Session-scoped right bar and does not fabricate a retained Session.
    function SettingsPanel({
      t, data, status, error, saving, saveError, saved, form, dirty, catalog,
      onField, onModel, onSave, onClose, onRetry, panelRef,
      telegramDm, onTelegramDm, adoptTelegram, adopting, adoptError, adopted,
    }) {
      const telegram = data?.telegram ?? null;
      const binding = telegram?.binding ?? { kind: 'none' };
      const bindingText = binding.kind === 'agent' ? `#${binding.chatId}` : t('settings.telegram.none');
      const groups = catalog?.groups ?? [];
      const found = form === null ? undefined
        : groups.find((group) => group.id === form.provider)?.models.find((entry) => entry.id === form.model);
      const efforts = found?.reasoning?.efforts ?? [];
      const modelValue = form !== null && form.provider !== '' ? `${form.provider}\u0000${form.model}` : '';
      const children = [
        h('div', { key: 'header', className: 'sa-sideHeader' },
          h('h2', { className: 'sa-sideTitle' }, t('settings.open')),
          h('button', {
            type: 'button', className: 'sa-iconButton', 'aria-label': t('settings.close'), onClick: onClose,
          }, '\u00d7')),
        h('div', { key: 'body', className: 'sa-sideBody' },
          status === 'loading' || (status === 'ready' && form === null)
            ? h('p', { className: 'sa-muted' }, t('settings.loading')) : null,
          status === 'error'
            ? h('div', { className: 'sa-field' },
              h('p', { className: 'sa-failure', role: 'alert' }, error || t('settings.error.read')),
              h('button', { type: 'button', className: 'sa-button', onClick: onRetry }, t('action.retry')))
            : null,
          form === null || status !== 'ready' ? null : h('div', { key: 'form', className: 'sa-field' },
            h('div', { className: 'sa-field' },
              h('label', { className: 'sa-fieldLabel', htmlFor: 'sa-settings-title' }, t('settings.title')),
              h('input', {
                id: 'sa-settings-title', className: 'sa-fieldInput', value: form.title,
                onChange: (event) => onField('title', event.target.value),
              })),
            h('div', { className: 'sa-field' },
              h('label', { className: 'sa-fieldLabel', htmlFor: 'sa-settings-cwd' }, t('settings.cwd')),
              h('input', {
                id: 'sa-settings-cwd', className: 'sa-fieldInput', value: form.cwd, spellCheck: false,
                onChange: (event) => onField('cwd', event.target.value),
              })),
            h('div', { className: 'sa-field' },
              h('label', { className: 'sa-fieldLabel', htmlFor: 'sa-settings-model' }, t('settings.model')),
              h('select', {
                id: 'sa-settings-model', className: 'sa-fieldInput', value: modelValue,
                onChange: (event) => {
                  const [provider, model] = String(event.target.value).split('\u0000');
                  if (provider && model) onModel(provider, model);
                },
              },
                modelValue === '' ? h('option', { key: 'empty', value: '' }, '') : null,
                groups.map((group) => h('optgroup', { key: group.id, label: group.name },
                  group.models.map((entry) => h('option', {
                    key: entry.id, value: `${group.id}\u0000${entry.id}`,
                  }, entry.name)))),
                modelValue !== '' && found === undefined
                  ? h('option', { key: 'current', value: modelValue }, `${form.provider}/${form.model}`) : null)),
            h('div', { className: 'sa-field' },
              h('label', { className: 'sa-fieldLabel', htmlFor: 'sa-settings-effort' }, t('settings.thinking')),
              h('select', {
                id: 'sa-settings-effort', className: 'sa-fieldInput', value: form.effort,
                disabled: form.model === '',
                onChange: (event) => onField('effort', event.target.value),
              },
                h('option', { key: 'default', value: '' }, t('effort.default')),
                efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name)),
                form.effort !== '' && !efforts.some((effort) => effort.id === form.effort)
                  ? h('option', { key: 'current', value: form.effort }, form.effort) : null)),
            saveError === null || saveError === undefined
              ? null : h('p', { className: 'sa-failure', role: 'alert' }, saveError),
            h('div', { className: 'sa-sideActions' },
              h('button', {
                type: 'button', id: 'sa-settings-save', className: 'sa-button',
                disabled: saving || dirty !== true || status !== 'ready', onClick: onSave,
              }, t('settings.save')),
              saved ? h('span', { className: 'sa-saved', role: 'status' }, t('settings.saved')) : null)),
          telegram === null ? null : h('div', { key: 'telegram', className: 'sa-telegram' },
            h('div', { className: 'sa-sideSectionTitle' }, t('settings.telegram')),
            h('div', { className: 'sa-metaRow' },
              h('span', { className: 'sa-metaLabel' }, t('settings.telegram.status')),
              h('span', { className: 'sa-metaValue' }, telegramStateLabel(telegram, t))),
            h('div', { className: 'sa-metaRow' },
              h('span', { className: 'sa-metaLabel' }, t('settings.telegram.target')),
              h('span', { className: 'sa-metaValue' }, t('settings.agent'))),
            h('div', { className: 'sa-metaRow' },
              h('span', { className: 'sa-metaLabel' }, t('settings.telegram.binding')),
              h('span', { className: 'sa-metaValue' }, bindingText)),
            binding.kind !== 'agent' && Array.isArray(telegram.candidates) && telegram.candidates.length > 0
              ? h('div', { className: 'sa-dmRow' },
                h('label', { className: 'sa-fieldLabel', htmlFor: 'sa-settings-dm' }, t('settings.telegram.dm')),
                h('select', {
                  id: 'sa-settings-dm', className: 'sa-fieldInput', value: telegramDm,
                  onChange: (event) => onTelegramDm(event.target.value),
                }, telegram.candidates.map((candidate) => h('option', {
                  key: candidate.key, value: candidate.key,
                }, `#${candidate.chatId}`))),
                h('button', {
                  type: 'button', id: 'sa-settings-adopt', className: 'sa-button',
                  disabled: adopting || telegramDm === '' || status !== 'ready', onClick: adoptTelegram,
                }, t('settings.telegram.adopt'))) : null,
            binding.kind !== 'agent' && (!Array.isArray(telegram.candidates) || telegram.candidates.length === 0)
              ? h('div', { className: 'sa-metaRow' },
                h('span', { className: 'sa-metaLabel' }, t('settings.telegram.dm')),
                h('span', { className: 'sa-metaValue' }, t('settings.telegram.none'))) : null,
            adopted ? h('p', { className: 'sa-saved', role: 'status' }, t('settings.telegram.adopted')) : null,
            adoptError === null || adoptError === undefined
              ? null : h('p', { className: 'sa-failure', role: 'alert' }, adoptError),
            typeof telegram.reason === 'string' && telegram.reason !== ''
              ? h('p', { className: 'sa-failure', role: 'alert' }, telegram.reason) : null)),
      ];
      return h('aside', {
        className: 'sa-side', id: 'sa-settings', role: 'dialog', 'aria-modal': false,
        'aria-label': t('settings.open'), tabIndex: -1, ref: panelRef,
        onKeyDown: (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        },
      }, ...children);
    }

    function AgentChat({ useChat, refresh, chat, catalog, setModel, settings, saveSettings, telegramAdopt, image, stop, ctx }) {
      const t = useTranslate(ctx);
      const snapshot = useChat((value) => value);
      const { status, data, error } = snapshot;
      const [draft, setDraft] = React.useState('');
      const [sending, setSending] = React.useState(false);
      const [sendError, setSendError] = React.useState(null);
      const [pending, setPending] = React.useState([]);
      const [files, setFiles] = React.useState([]);
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [menuMode, setMenuMode] = React.useState('model');
      const [catalogData, setCatalogData] = React.useState(null);
      const [catalogError, setCatalogError] = React.useState(null);
      const [atBottom, setAtBottom] = React.useState(true);
      const [hasNew, setHasNew] = React.useState(false);
      const [stopped, setStopped] = React.useState(false);
      const [announce, setAnnounce] = React.useState('');
      const [panelOpen, setPanelOpen] = React.useState(false);
      const [panelStatus, setPanelStatus] = React.useState('idle');
      const [panelData, setPanelData] = React.useState(null);
      const [panelError, setPanelError] = React.useState(null);
      const [form, setForm] = React.useState(null);
      const [initialForm, setInitialForm] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [saveError, setSaveError] = React.useState(null);
      const [saved, setSaved] = React.useState(false);
      const [telegramDm, setTelegramDm] = React.useState('');
      const [adopting, setAdopting] = React.useState(false);
      const [adoptError, setAdoptError] = React.useState(null);
      const [adopted, setAdopted] = React.useState(false);
      const listRef = React.useRef(null);
      const inputRef = React.useRef(null);
      const fileInputRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const modelButtonRef = React.useRef(null);
      const effortButtonRef = React.useRef(null);
      const stickRef = React.useRef(true);
      const suppressPin = React.useRef(false);
      const stoppedRef = React.useRef(false);
      const lastRunning = React.useRef(false);
      const announcedRef = React.useRef('');
      const settingsButtonRef = React.useRef(null);
      const sideRef = React.useRef(null);
      const labels = React.useMemo(() => ({
        code: {
          copyLabel: t('md.copy'),
          copiedLabel: t('md.copied'),
          toolbarLabels: { codeLabel: t('md.code'), wrapLabel: t('md.wrap'), unwrapLabel: t('md.unwrap') },
        },
        footnotes: t('md.footnotes'),
      }), [t]);

      const messages = data?.messages ?? [];
      const reports = data?.reports ?? [];
      const allMessages = React.useMemo(() => {
        const ordered = [...messages, ...reports].sort((left, right) => {
          const leftTime = typeof left.time === 'number' ? left.time : 0;
          const rightTime = typeof right.time === 'number' ? right.time : 0;
          if (leftTime !== rightTime) return leftTime - rightTime;
          const leftSeq = typeof left.seq === 'number' ? left.seq : 0;
          const rightSeq = typeof right.seq === 'number' ? right.seq : 0;
          if (leftSeq !== rightSeq) return leftSeq - rightSeq;
          return String(left.id).localeCompare(String(right.id));
        });
        return [...ordered, ...pending];
      }, [data, pending]);
      const items = React.useMemo(() => buildItems(allMessages), [allMessages]);
      const streaming = data?.streaming ?? null;

      React.useEffect(() => {
        setPending((current) => current.filter((message) => !messages.some((known) => known.id === message.id)));
      }, [data]);

      React.useEffect(() => {
        if (catalogData !== null) return undefined;
        let cancelled = false;
        void (async () => {
          try {
            const result = await catalog();
            if (!cancelled && result.ok) setCatalogData(result.value);
          } catch {
            // The model menu retries on open.
          }
        })();
        return () => { cancelled = true; };
      }, []);

      const say = (text) => {
        if (text === '' || announcedRef.current === text) return;
        announcedRef.current = text;
        setAnnounce(text);
      };

      const loadSettings = React.useCallback(async (options = {}) => {
        setPanelStatus('loading');
        setPanelError(null);
        if (options.keepError !== true) setSaveError(null);
        setSaved(false);
        try {
          if (catalogData === null) {
            try {
              const result = await catalog();
              if (result.ok) setCatalogData(result.value);
            } catch {
              // The model select keeps the current value until a read succeeds.
            }
          }
          const result = await settings();
          if (!result.ok) {
            setPanelStatus('error');
            setPanelError(result.error?.message || t('settings.error.read'));
            return;
          }
          const next = settingsFormOf(result.value);
          setPanelData(result.value);
          setForm(next);
          setInitialForm(next);
          const candidates = result.value?.telegram?.candidates ?? [];
          setTelegramDm((current) => (candidates.some((entry) => entry.key === current) ? current : candidates[0]?.key ?? ''));
          setPanelStatus('ready');
        } catch (failure) {
          setPanelStatus('error');
          setPanelError(failure?.message || t('settings.error.read'));
        }
      }, [catalogData, catalog, settings, t]);

      const openPanel = () => {
        setPanelOpen(true);
        setAdopted(false);
        void loadSettings();
      };
      const closePanel = () => {
        setPanelOpen(false);
        setPanelStatus('idle');
        settingsButtonRef.current?.focus();
      };
      const onField = (key, value) => setForm((current) => (current === null ? current : { ...current, [key]: value }));
      const onModel = (provider, model) => setForm((current) => {
        if (current === null) return current;
        const found = catalogData?.groups?.find((group) => group.id === provider)?.models.find((entry) => entry.id === model);
        const efforts = found?.reasoning?.efforts ?? [];
        return { ...current, provider, model, effort: efforts.some((effort) => effort.id === current.effort) ? current.effort : '' };
      });
      const adoptTelegram = async () => {
        if (adopting || telegramDm === '') return;
        setAdopting(true);
        setAdoptError(null);
        setAdopted(false);
        try {
          const result = await telegramAdopt({ key: telegramDm });
          if (!result.ok) {
            setAdoptError(result.error?.message || t('settings.error.adopt'));
            return;
          }
          await loadSettings({ keepError: true });
          setAdopted(true);
          refresh();
        } catch (failure) {
          setAdoptError(failure?.message || t('settings.error.adopt'));
        } finally {
          setAdopting(false);
        }
      };
      const savePanel = async () => {
        if (saving) return;
        const patch = settingsPatchOf(form, initialForm);
        if (patch === null || Object.keys(patch).length === 0) return;
        setSaving(true);
        setSaveError(null);
        setSaved(false);
        try {
          const result = await saveSettings({ ...patch, expectedRevision: panelData?.revision ?? null });
          if (!result.ok) {
            setSaveError(result.error?.message || t('settings.error.save'));
            if (result.error?.code === 'SETTINGS_CONFLICT') void loadSettings({ keepError: true });
            return;
          }
          const next = settingsFormOf(result.value);
          setPanelData(result.value);
          setForm(next);
          setInitialForm(next);
          setSaved(true);
          refresh();
        } catch (failure) {
          setSaveError(failure?.message || t('settings.error.save'));
        } finally {
          setSaving(false);
        }
      };

      React.useEffect(() => {
        if (panelOpen) sideRef.current?.focus?.();
      }, [panelOpen]);

      React.useLayoutEffect(() => {
        const list = listRef.current;
        if (list === null) return;
        if (stickRef.current) {
          list.scrollTop = list.scrollHeight;
          if (hasNew) setHasNew(false);
        } else if (allMessages.length > 0 || streaming !== null) {
          if (!hasNew) setHasNew(true);
        }
      }, [allMessages.length, streaming]);

      // Images and late layout growth arrive after the first paint. While the
      // reader is pinned, follow that growth; when they are reading earlier
      // turns, only correct the jump control's visibility.
      React.useEffect(() => {
        const list = listRef.current;
        if (list === null || typeof ResizeObserver === 'undefined') return undefined;
        const settle = () => {
          if (stickRef.current && suppressPin.current !== true) list.scrollTop = list.scrollHeight;
          const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
          setAtBottom(distance < 48);
        };
        const observer = new ResizeObserver(settle);
        observer.observe(list);
        if (list.firstElementChild !== null) observer.observe(list.firstElementChild);
        settle();
        return () => observer.disconnect();
      }, [data?.ready]);

      React.useEffect(() => {
        if (data === null) return;
        if (data.running === true && lastRunning.current !== true) {
          setStopped(false);
          stoppedRef.current = false;
          say(t('status.running'));
        } else if (data.running !== true && lastRunning.current === true) {
          const text = stoppedRef.current ? t('status.stopped') : t('status.reply');
          if (stoppedRef.current) setStopped(true);
          say(text);
        }
        lastRunning.current = data.running === true;
      }, [data?.running]);

      React.useEffect(() => {
        if (menuOpen) menuRef.current?.focus();
      }, [menuOpen]);

      const closeMenu = React.useCallback(() => {
        setMenuOpen(false);
        const target = menuMode === 'effort' ? effortButtonRef.current : modelButtonRef.current;
        target?.focus();
      }, [menuMode]);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape' || !menuOpen) return;
          closeMenu();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [menuOpen, closeMenu]);

      // Expanding a disclosure changes the transcript's height. Do not treat
      // that as new conversation content: keep the main transcript where the
      // reader left it and let the capped body scroll internally instead.
      const toggleWithoutPin = (element, change) => {
        suppressPin.current = true;
        change();
        window.setTimeout(() => { suppressPin.current = false; }, 250);
      };

      const scrollToLatest = () => {
        const list = listRef.current;
        if (list === null) return;
        stickRef.current = true;
        setAtBottom(true);
        setHasNew(false);
        const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        if (typeof list.scrollTo === 'function') list.scrollTo({ top: list.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
        else list.scrollTop = list.scrollHeight;
        inputRef.current?.focus();
      };

      const onScroll = () => {
        const list = listRef.current;
        if (list === null) return;
        const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
        const near = distance < 48;
        stickRef.current = near;
        if (near !== atBottom) setAtBottom(near);
        if (near && hasNew) setHasNew(false);
      };

      const openMenu = async (mode) => {
        if (menuOpen && menuMode === mode) {
          closeMenu();
          return;
        }
        setMenuMode(mode);
        setMenuOpen(true);
        setCatalogError(null);
        if (catalogData !== null) return;
        try {
          const result = await catalog();
          if (!result.ok) {
            setCatalogError(result.error?.message || t('error.read'));
            return;
          }
          setCatalogData(result.value);
        } catch (failure) {
          setCatalogError(failure?.message || t('error.read'));
        }
      };
      const chooseModel = async (provider, model) => {
        setCatalogError(null);
        try {
          const result = await setModel({ provider, model });
          if (!result.ok) {
            setCatalogError(result.error?.message || t('error.read'));
            return;
          }
          setMenuOpen(false);
          modelButtonRef.current?.focus();
          refresh();
        } catch (failure) {
          setCatalogError(failure?.message || t('error.read'));
        }
      };
      const chooseEffort = async (effort) => {
        if (data?.model === null || data?.model === undefined) return;
        setCatalogError(null);
        try {
          const result = await setModel({
            provider: data.model.provider,
            model: data.model.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          });
          if (!result.ok) {
            setCatalogError(result.error?.message || t('error.read'));
            return;
          }
          setMenuOpen(false);
          effortButtonRef.current?.focus();
          refresh();
        } catch (failure) {
          setCatalogError(failure?.message || t('error.read'));
        }
      };
      const readBase64 = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? '');
          const comma = result.indexOf(',');
          resolve(comma >= 0 ? result.slice(comma + 1) : '');
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const addFiles = async (picked, { dedupe = false } = {}) => {
        if (picked.length === 0) return;
        const next = [];
        const seen = new Set();
        for (const file of picked) {
          if (file.size > 10 * 1024 * 1024) {
            setSendError(t('error.fileSize'));
            continue;
          }
          try {
            const encoded = await readBase64(file);
            if (dedupe) {
              if (seen.has(encoded)) continue;
              seen.add(encoded);
            }
            const rawType = typeof file.type === 'string' ? file.type.toLowerCase() : '';
            const mediaType = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
            next.push({ name: file.name, mediaType, data: encoded });
          } catch {
            setSendError(t('error.file'));
          }
        }
        setFiles((current) => {
          const fresh = dedupe ? next.filter((file) => !current.some((known) => known.data === file.data)) : next;
          return fresh.length === 0 ? current : [...current, ...fresh].slice(0, 8);
        });
      };
      const attach = async (event) => {
        const picked = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (picked.length === 0) return;
        setSendError(null);
        await addFiles(picked);
      };
      const pasteClipboard = (event) => {
        const data = event.clipboardData;
        if (data === null || data === undefined) return;
        const images = clipboardImageFiles(data);
        if (images.length === 0) return;
        const supported = [];
        let rejected = 0;
        for (const file of images) {
          if (SUPPORTED_IMAGE.test(file.type)) supported.push(pastedImageName(file));
          else rejected += 1;
        }
        const text = typeof data.getData === 'function' ? data.getData('text/plain') : '';
        // Keep the browser's normal text/multiline paste when the clipboard
        // also carries text; only an image-only paste has no text to lose.
        if (text === '') event.preventDefault();
        setSendError(null);
        if (rejected > 0) setSendError(t('error.imageType'));
        if (supported.length > 0) void addFiles(supported, { dedupe: true });
      };
      const dropFiles = (event) => {
        const data = event.dataTransfer;
        if (data === null || data === undefined) return;
        const picked = Array.from(data.files ?? []);
        if (picked.length === 0) return;
        const supported = [];
        let rejected = 0;
        for (const file of picked) {
          if (SUPPORTED_IMAGE.test(file.type)) supported.push(pastedImageName(file));
          else rejected += 1;
        }
        setSendError(null);
        if (rejected > 0) setSendError(t('error.imageType'));
        if (supported.length > 0) void addFiles(supported, { dedupe: true });
      };
      const removeFile = (index) => setFiles((current) => current.filter((_, position) => position !== index));

      if (data === null) {
        if (status === 'error') {
          return h('section', { className: 'sa-page', 'aria-label': t('title') },
            h('div', { className: 'sa-centered' },
              h('p', { className: 'sa-failure', role: 'alert' }, error || t('error.start')),
              h('button', { type: 'button', className: 'sa-button', onClick: refresh }, t('action.retry'))));
        }
        return h('section', { className: 'sa-page', 'aria-label': t('title') },
          h('div', { className: 'sa-centered' }, status === 'loading' ? t('loading') : t('error.connecting')));
      }
      if (data.ready !== true) {
        return h('section', { className: 'sa-page', 'aria-label': t('title') },
          h('div', { className: 'sa-centered' },
            h('p', { className: 'sa-failure', role: 'alert' }, data.error || t('error.start')),
            h('button', { type: 'button', className: 'sa-button', onClick: refresh }, t('action.retry'))));
      }

      const canSend = (draft.trim() !== '' || files.length > 0) && !sending;
      const send = async () => {
        if (!canSend) return;
        setSending(true);
        setSendError(null);
        const text = draft.trim();
        const attached = files.map((file) => ({ name: file.name }));
        try {
          const result = await chat({
            text,
            files: files.map((file) => ({ name: file.name, mediaType: file.mediaType, data: file.data })),
          });
          if (!result.ok) {
            setSendError(result.error?.message || t('error.send'));
            return;
          }
          setDraft('');
          setStopped(false);
          stoppedRef.current = false;
          setPending((current) => [...current, {
            id: result.value.messageId, role: 'user', source: 'user', text, attachments: attached,
          }]);
          setFiles([]);
          stickRef.current = true;
          setAtBottom(true);
          setHasNew(false);
          refresh();
        } catch (failure) {
          setSendError(failure?.message || t('error.send'));
        } finally {
          setSending(false);
          inputRef.current?.focus();
        }
      };
      const stopAgent = async () => {
        setSendError(null);
        try {
          const result = await stop();
          if (result && result.ok === false) {
            setSendError(result.error?.message || t('error.stop'));
            return;
          }
          const accepted = !(result && result.ok === true && result.value && result.value.stopped === false);
          if (accepted) {
            stoppedRef.current = true;
            setStopped(true);
            say(t('status.stopped'));
          }
        } catch (failure) {
          setSendError(failure?.message || t('error.stop'));
        } finally {
          refresh();
          inputRef.current?.focus();
        }
      };
      const selection = data.model;
      const running = data.running === true;
      const stateText = running ? t('state.running') : stopped ? t('state.stopped') : t('state.idle');
      const panelPatch = settingsPatchOf(form, initialForm);
      const panelDirty = panelPatch !== null && Object.keys(panelPatch).length > 0;

      return h('section', { className: 'sa-page', 'aria-label': t('title'), 'data-plugin': '@local/dsh-sidebar-agent' },
        h('div', { className: 'sa-header' },
          h('h1', { className: 'sa-title', tabIndex: -1 }, data.title || t('title')),
          h('div', { className: 'sa-headerActions' },
            h('span', { className: 'sa-state' },
              h(StateDot, { state: running ? 'ongoing' : 'idle', size: running ? 13 : 10 }),
              stateText),
            h('button', {
              type: 'button', ref: settingsButtonRef, className: 'sa-iconButton',
              'aria-label': t('settings.open'), 'aria-expanded': panelOpen, 'aria-controls': 'sa-settings',
              onClick: panelOpen ? closePanel : openPanel,
            }, h(SlidersIcon), h('span', { className: 'sa-iconLabel' }, t('settings.open'))))),
        h('span', { className: 'sa-sr', role: 'status', 'aria-live': 'polite' }, announce),
        h('div', { className: 'sa-body' },
          h('div', { className: 'sa-main' },
            h('div', { className: 'sa-transcriptWrap' },
              h('div', {
                className: 'sa-scroll', ref: listRef, role: 'log', 'aria-live': 'off', 'aria-relevant': 'additions',
                'aria-label': t('transcript'), onScroll,
              },
                h('div', { className: 'sa-column' },
                  data.truncated === true ? h('p', { className: 'sa-muted' }, t('earlier')) : null,
                  items.map((item) => item.kind === 'tools'
                    ? h(ActivityGroup, { key: item.id, tools: item.tools, t, image, onToggle: toggleWithoutPin })
                    : h(MessageRow, { key: item.id, message: item.message, t, image, labels, onToggle: toggleWithoutPin })),
                  streaming === null ? null : h('div', { className: 'sa-turn sa-assistant' },
                    h(MarkdownBody, { text: streaming, streaming: true, labels })),
                  error === null || error === undefined ? null : h('p', { className: 'sa-failure', role: 'alert' }, error))),
              !atBottom ? h('button', {
                type: 'button', className: 'sa-jump', onClick: scrollToLatest,
                'aria-label': hasNew ? t('action.latestNew') : t('action.latest'),
              },
                hasNew ? h('span', { className: 'sa-jumpDot', 'aria-hidden': true }) : null,
                h('span', null, t('action.latest')),
                h('span', { 'aria-hidden': true }, '\u2193')) : null),
            h(Composer, {
              t, draft, setDraft, files, attach, pasteClipboard, dropFiles, removeFile, send, stop: stopAgent, running, sending, sendError,
              selection, catalogData, catalogError, menuOpen, menuMode, openMenu, closeMenu, chooseModel, chooseEffort,
              inputRef, fileInputRef, menuRef, modelButtonRef, effortButtonRef,
            })),
          panelOpen ? h('div', { key: 'backdrop', className: 'sa-sideBackdrop', onClick: closePanel, 'aria-hidden': true }) : null,
          panelOpen ? h(SettingsPanel, {
            key: 'panel', t, data: panelData, status: panelStatus, error: panelError, saving,
            saveError, saved, form, dirty: panelDirty, catalog: catalogData,
            onField, onModel, onSave: savePanel, onClose: closePanel, onRetry: loadSettings, panelRef: sideRef,
            telegramDm, onTelegramDm: setTelegramDm, adoptTelegram, adopting, adoptError, adopted,
          }) : null),
      );
    }

    function AgentPanelIcon({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        stroke: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, [
        h('rect', { key: 'a', x: 4, y: 7.5, width: 16, height: 12, rx: 3 }),
        h('path', { key: 'b', d: 'M12 7.5V4.5' }),
        h('circle', { key: 'c', cx: 12, cy: 3.5, r: 1 }),
        h('circle', { key: 'd', cx: 9, cy: 12.5, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'e', cx: 15, cy: 12.5, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('path', { key: 'f', d: 'M9 16.5h6' }),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN }), 'sidebar-agent: locale');
      const t = ctx.locale.bind(NS);
      let remote;
      let store = { status: 'idle', data: null, error: null };
      const listeners = new Set();
      const publish = (changes) => {
        store = { ...store, ...changes };
        for (const notify of listeners) notify();
      };
      let inFlight = false;
      let timer;
      const POLL_MS = 1500;
      const load = async (quiet = false) => {
        if (inFlight) return;
        inFlight = true;
        if (!quiet) publish({ status: 'loading', error: null });
        try {
          if (!remote) throw new Error(t('error.connecting'));
          const result = await remote.status();
          if (!result.ok) {
            publish({ status: 'error', error: result.error?.message || t('error.read') });
            return;
          }
          publish({ status: 'ready', data: result.value, error: null });
        } catch (error) {
          publish({ status: 'error', error: error?.message || t('error.read') });
        } finally {
          inFlight = false;
        }
      };
      const wake = () => {
        if (document.visibilityState === 'visible') load(true);
      };
      let delegatedInFlight = false;
      const spinnerStyle = document.createElement('style');
      spinnerStyle.dataset.plugin = '@local/dsh-sidebar-agent/delegated-spinner';
      const syncSpinnerStyles = () => {
        spinnerStyle.textContent = delegatedSpinnerCss(delegatedStore.ids, delegatedStore.stalled);
      };
      ctx.effect(() => {
        document.head.append(spinnerStyle);
        syncSpinnerStyles();
        return () => spinnerStyle.remove();
      }, 'sidebar-agent: delegated spinner accent');
      const refreshDelegated = async () => {
        if (remote === undefined || delegatedInFlight) return;
        delegatedInFlight = true;
        try {
          const result = await remote.delegated();
          if (!result.ok) return;
          delegatedStore.ids = new Set(result.value?.sessionIds ?? []);
          delegatedStore.stalled = new Set(result.value?.stalledSessionIds ?? []);
          syncSpinnerStyles();
          for (const notify of delegatedStore.listeners) notify();
        } catch {
          // A failed read keeps the last known tags.
        } finally {
          delegatedInFlight = false;
        }
      };
      ctx.effect(() => {
        const delegatedTimer = setInterval(() => void refreshDelegated(), 2000);
        return () => clearInterval(delegatedTimer);
      }, 'sidebar-agent: delegated tags');
      const useChat = (selector) => {
        const [, force] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => {
          listeners.add(force);
          if (listeners.size === 1) {
            if (store.status !== 'loading') load();
            timer = setInterval(() => load(true), POLL_MS);
            document.addEventListener('visibilitychange', wake);
          }
          return () => {
            listeners.delete(force);
            if (listeners.size > 0) return;
            clearInterval(timer);
            timer = undefined;
            document.removeEventListener('visibilitychange', wake);
          };
        }, []);
        return selector(store);
      };
      ctx.effect(() => {
        let disposed = false;
        let face;
        Promise.resolve(ctx.remote.$mount(contribution())).then(() => {
          if (disposed) return;
          face = ctx.inject(['remote.agent'], (scoped) => {
            remote = scoped.remote.agent;
            if (listeners.size > 0) load(true);
            void refreshDelegated();
          });
        }).catch((error) => {
          if (!disposed) publish({ status: 'error', error: error?.message || t('error.read') });
        });
        return () => { disposed = true; remote = undefined; face?.dispose?.(); };
      }, 'sidebar-agent: remote');
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, locale: NS,
        inject: () => ({
          useChat,
          refresh: load,
          chat: (request) => remote.chat(request),
          catalog: () => remote.catalog(),
          setModel: (request) => remote.setModel(request),
          settings: () => remote.settings(),
          saveSettings: (request) => remote.saveSettings(request),
          telegramAdopt: (request) => remote.telegramAdopt(request),
          image: (request) => remote.image(request),
          stop: () => remote.stop(),
          ctx,
        }),
      }, AgentChat)), 'sidebar-agent: page');
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 5, locale: NS,
        label: () => t('panel'),
      }, AgentPanelIcon)), 'sidebar-agent: sidebar entry');
      ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'delegated-tag', order: 30, locale: NS,
        inject: () => ({ useDelegated, useStalled, t }),
      }, DelegationTag)), 'sidebar-agent: delegated header tag');
      ctx.effect(() => ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
        name: 'sidebar.session.row.hover', id: 'delegated-hover', order: 20, locale: NS,
        inject: () => ({ useDelegated, useStalled, t }),
      }, DelegationTag)), 'sidebar-agent: delegated hover tag');
      ctx.effect(() => ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
        name: 'sidebar.session.row.leading', id: 'delegated-mark', order: 20, locale: NS,
        inject: () => ({ useDelegated, useStalled, t }),
      }, DelegationMark)), 'sidebar-agent: delegated row mark');
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = '@local/dsh-sidebar-agent';
        style.textContent = CSS;
        document.head.append(style);
        return () => style.remove();
      }, 'sidebar-agent: styles');
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      apply,
      __internals: {
        AgentChat, Composer, MessageRow, ToolRow, ActivityGroup, DelegationReport, ModelMenu,
        SettingsPanel, settingsFormOf, settingsPatchOf, telegramStateLabel,
        buildItems, parseReport, outcomeLabel, outcomeClass, toolPhrase, humanToolName,
        modelLabel, effortLabel, delegatedSpinnerCss, CSS,
        DelegationTag, DelegationMark, useDelegated, useStalled,
      },
    };
  },
});
