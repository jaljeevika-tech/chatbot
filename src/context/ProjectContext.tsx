// Selected-project state; a "project" is an action_plans row. selectedProjectKey is
// persisted in localStorage so a refresh keeps the user on their project.

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { apiFetch } from '../utils/apiFetch'

export interface PortfolioProject {
  id: string
  project_key: string
  name: string
  year: number | null
  donor: string | null
  region: string | null
  budget: number | null
  end_date: string | null
  locations: string[]
  health: 'green' | 'amber' | 'red'
  compliance: 'green' | 'amber' | 'red'
  target: number
  budgetUsed: number
  active: boolean
}

interface ProjectContextValue {
  projects: PortfolioProject[]
  loading: boolean
  selectedProject: PortfolioProject | null
  selectedProjectKey: string | null
  loadProjects: () => Promise<void>
  selectProject: (projectKey: string | null) => void
}

const ProjectContext = createContext<ProjectContextValue | null>(null)
const STORAGE_KEY = 'ff_selected_project_key'

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<PortfolioProject[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY)
  )

  const loadProjects = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/action-plans')
      const data = await res.json()
      if (res.ok) setProjects(data.plans || [])
    } catch {
      // Keep projects as-is on network failure
    }
    setLoading(false)
  }, [])

  const selectProject = useCallback((projectKey: string | null) => {
    setSelectedProjectKey(projectKey)
    if (projectKey) localStorage.setItem(STORAGE_KEY, projectKey)
    else localStorage.removeItem(STORAGE_KEY)
  }, [])

  // Drop the selection if the persisted project no longer exists
  useEffect(() => {
    if (selectedProjectKey && projects.length && !projects.some(p => p.project_key === selectedProjectKey)) {
      selectProject(null)
    }
  }, [projects, selectedProjectKey, selectProject])

  const selectedProject = projects.find(p => p.project_key === selectedProjectKey) || null

  return (
    <ProjectContext.Provider value={{ projects, loading, selectedProject, selectedProjectKey, loadProjects, selectProject }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProjectContext() {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProjectContext must be inside ProjectProvider')
  return ctx
}
