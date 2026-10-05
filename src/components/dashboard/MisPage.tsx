// MIS tab: one sub-tab per activity category, each scoped to the open project.
// The page header comes from DashboardPage PAGE_META; the cross-category rollup lives in ProjectDashboardPage.

import { useState } from 'react'
import { TabPill } from '../ui/TabPill'
import { TrainingPage } from './TrainingPage'
import { IncomePage } from './IncomePage'
import { InputDistributionPage } from './InputDistributionPage'
import { SchemeAccessPage } from './SchemeAccessPage'
import { CreditGrantAccessPage } from './CreditGrantAccessPage'
import { BusinessDevelopmentSupportPage } from './BusinessDevelopmentSupportPage'
import { ComplianceSupportPage } from './ComplianceSupportPage'
import { CampaignPage } from './CampaignPage'
import { ExposureVisitPage } from './ExposureVisitPage'
import { CommunityMeetingPage } from './CommunityMeetingPage'

type MisSubTab = 'training' | 'inputdistribution' | 'schemeaccess' | 'creditgrant' | 'bds' | 'compliance' | 'campaign' | 'exposurevisit' | 'communitymeeting' | 'income'

interface Props {
  projectKey: string
}

const SUB_TABS: { key: MisSubTab; label: string }[] = [
  { key: 'training',          label: 'Training' },
  { key: 'inputdistribution', label: 'Input Distribution' },
  { key: 'schemeaccess',      label: 'Scheme Access' },
  { key: 'creditgrant',       label: 'Credit/Grant Access' },
  { key: 'bds',               label: 'Business Development Support' },
  { key: 'compliance',        label: 'Compliance Support' },
  { key: 'campaign',          label: 'Campaign' },
  { key: 'exposurevisit',     label: 'Exposure Visit' },
  { key: 'communitymeeting',  label: 'Community Meeting' },
  { key: 'income',            label: 'Income' },
]

export function MisPage({ projectKey }: Props) {
  const [subTab, setSubTab] = useState<MisSubTab>('training')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <TabPill tabs={SUB_TABS} active={subTab} onChange={setSubTab} />

      {subTab === 'training' && <TrainingPage projectKey={projectKey} />}
      {subTab === 'inputdistribution' && <InputDistributionPage projectKey={projectKey} />}
      {subTab === 'schemeaccess' && <SchemeAccessPage projectKey={projectKey} />}
      {subTab === 'creditgrant' && <CreditGrantAccessPage projectKey={projectKey} />}
      {subTab === 'bds' && <BusinessDevelopmentSupportPage projectKey={projectKey} />}
      {subTab === 'compliance' && <ComplianceSupportPage projectKey={projectKey} />}
      {subTab === 'campaign' && <CampaignPage projectKey={projectKey} />}
      {subTab === 'exposurevisit' && <ExposureVisitPage projectKey={projectKey} />}
      {subTab === 'communitymeeting' && <CommunityMeetingPage projectKey={projectKey} />}
      {subTab === 'income' && <IncomePage projectKey={projectKey} />}
    </div>
  )
}
