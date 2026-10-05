import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { COMPLIANCE_SUPPORT_UPLOAD } from './misUploadConfigs'

export function UploadComplianceSupportModal(props: MisUploadProps) {
  return <MisUploadModal config={COMPLIANCE_SUPPORT_UPLOAD} {...props} />
}
