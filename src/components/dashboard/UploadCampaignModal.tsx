import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { CAMPAIGN_UPLOAD } from './misUploadConfigs'

export function UploadCampaignModal(props: MisUploadProps) {
  return <MisUploadModal config={CAMPAIGN_UPLOAD} {...props} />
}
