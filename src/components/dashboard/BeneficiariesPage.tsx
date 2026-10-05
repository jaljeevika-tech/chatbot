// Beneficiary and Resource Registration: five org-wide sub-tabs (Individual Beneficiary,
// Micro-Entrepreneur, Collective, Resources, Indirect Beneficiary).

import { useState } from 'react'
import { FF } from '../../theme/colors'
import { IndividualBeneficiaryPage } from './IndividualBeneficiaryPage'
import { MicroEntrepreneurPage } from './MicroEntrepreneurPage'
import { CollectivePage } from './CollectivePage'
import { ResourcePage } from './ResourcePage'
import { IndirectBeneficiaryPage } from './IndirectBeneficiaryPage'

interface Props {
  projectKey?: string
  planId?: string
}

export function BeneficiariesPage({ projectKey: _projectKey, planId: _planId }: Props) {
  const [subTab, setSubTab] = useState<'individual' | 'entrepreneur' | 'collective' | 'resources' | 'indirect'>('individual')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'IBM Plex Sans',sans-serif" }}>

      <div className="flex items-center gap-2 flex-wrap" style={{ borderBottom: `1px solid ${FF.borderSoft}` }}>
        {([
          { key: 'individual', label: 'Individual Beneficiary' },
          { key: 'entrepreneur', label: 'Micro-Entrepreneur' },
          { key: 'collective', label: 'Collective' },
          { key: 'resources', label: 'Resources' },
          { key: 'indirect', label: 'Indirect Beneficiary' },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className="px-2.5 sm:px-4 py-2.5 text-xs sm:text-sm font-semibold"
            style={{
              color: subTab === t.key ? FF.purple : FF.textFaint,
              borderBottom: subTab === t.key ? `2px solid ${FF.purple}` : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'individual' && <IndividualBeneficiaryPage />}
      {subTab === 'entrepreneur' && <MicroEntrepreneurPage />}
      {subTab === 'collective' && <CollectivePage />}
      {subTab === 'resources' && <ResourcePage />}
      {subTab === 'indirect' && <IndirectBeneficiaryPage />}
    </div>
  )
}
