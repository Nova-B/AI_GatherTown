import { useEffect, useState } from 'react';

import { DetailsPanel } from './components/DetailsPanel.js';
import { SessionList } from './components/SessionList.js';
import { Timeline } from './components/Timeline.js';
import { TopBar } from './components/TopBar.js';
import { OfficeView } from './office/OfficeView.js';
import { useStore } from './store.js';

type MobileTab = 'office' | 'sessions' | 'details' | 'timeline';

export function App(): React.JSX.Element {
  const s = useStore();
  const [tab, setTab] = useState<MobileTab>('office');
  const [narrow, setNarrow] = useState(() => window.innerWidth < 900);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // When something gets selected on a phone, jump to the details tab.
  useEffect(() => {
    if (narrow && s.selection.agentId) setTab('details');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.selection.agentId]);

  return (
    <div className={`app ${narrow ? 'app-narrow' : ''}`} data-mode={s.mode}>
      <TopBar />
      <div className="app-body">
        {(!narrow || tab === 'sessions') && (
          <aside className="panel panel-left" data-testid="panel-sessions">
            <SessionList />
          </aside>
        )}
        {(!narrow || tab === 'office') && (
          <main className="stage">
            <OfficeView />
          </main>
        )}
        {(!narrow || tab === 'details') && (
          <aside className="panel panel-right" data-testid="panel-details">
            <DetailsPanel />
          </aside>
        )}
      </div>
      {(!narrow || tab === 'timeline') && (
        <footer className="panel panel-bottom" data-testid="panel-timeline">
          <Timeline />
        </footer>
      )}
      {narrow && (
        <nav className="tabbar" aria-label="화면 전환">
          {(
            [
              ['office', '사무실'],
              ['sessions', '세션'],
              ['details', '상세'],
              ['timeline', '타임라인'],
            ] as Array<[MobileTab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
              data-testid={`tab-${id}`}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
