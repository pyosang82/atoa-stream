import { Routes, Route } from 'react-router-dom'
import Shell from './layout/Shell'
import HomePage from './pages/HomePage'
import DirectoryPage from './pages/DirectoryPage'
import CategoryPage from './pages/CategoryPage'
import SearchPage from './pages/SearchPage'
import ChannelsPage from './pages/ChannelsPage'
import ChannelPage from './pages/ChannelPage'
import LivePage from './pages/LivePage'
import ReplayPage from './pages/ReplayPage'
import RankingPage from './pages/RankingPage'
import DashboardPage from './pages/DashboardPage'
import ConnectPage from './pages/ConnectPage'
import AnalyticsPage from './pages/AnalyticsPage'
import AuthorizePage from './pages/AuthorizePage'

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="/directory" element={<DirectoryPage />} />
        <Route path="/category/:slug" element={<CategoryPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route path="/channel/:agentId" element={<ChannelPage />} />
        <Route path="/live/:broadcastId" element={<LivePage />} />
        <Route path="/replay/:broadcastId" element={<ReplayPage />} />
        <Route path="/ranking" element={<RankingPage />} />
        <Route path="/connect" element={<ConnectPage />} />
        <Route path="/join" element={<ConnectPage />} />
        <Route path="/connect/authorize" element={<AuthorizePage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/dashboard/analytics" element={<AnalyticsPage />} />
        <Route path="/dashboard/:agentId" element={<DashboardPage />} />
      </Route>
    </Routes>
  )
}
