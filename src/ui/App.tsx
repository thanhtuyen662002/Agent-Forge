import React from 'react';
import { useOrchestrator, OrchestratorProvider } from './context/OrchestratorContext';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { EmergencyStopModal } from './components/EmergencyStopModal';
import { DashboardView } from './views/DashboardView';
import { ManualBridgeView } from './views/ManualBridgeView';
import { TaskBoardView } from './views/TaskBoardView';
import { TaskDetailView } from './views/TaskDetailView';
import { AgentCenterView } from './views/AgentCenterView';
import { CapacityView } from './views/CapacityView';
import { TimelineView } from './views/TimelineView';
import { DecisionsView } from './views/DecisionsView';
import { EvidenceView } from './views/EvidenceView';
import { ProjectsView } from './views/ProjectsView';
import { SettingsView } from './views/SettingsView';
import { DebugView } from './views/DebugView';

const MainLayout: React.FC = () => {
  const { activeView } = useOrchestrator();

  const renderView = () => {
    switch (activeView) {
      case 'dashboard':
        return <DashboardView />;
      case 'manual-bridge':
        return <ManualBridgeView />;
      case 'task-board':
        return <TaskBoardView />;
      case 'task-detail':
        return <TaskDetailView />;
      case 'agent-center':
        return <AgentCenterView />;
      case 'capacity':
        return <CapacityView />;
      case 'timeline':
        return <TimelineView />;
      case 'decisions':
        return <DecisionsView />;
      case 'evidence':
        return <EvidenceView />;
      case 'projects':
        return <ProjectsView />;
      case 'settings':
        return <SettingsView />;
      case 'debug':
        return <DebugView />;
      default:
        return <DashboardView />;
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-slate-100 overflow-hidden font-sans">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 bg-background overflow-y-auto">
          {renderView()}
        </main>
      </div>
      <EmergencyStopModal />
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <OrchestratorProvider>
      <MainLayout />
    </OrchestratorProvider>
  );
};

export default App;
