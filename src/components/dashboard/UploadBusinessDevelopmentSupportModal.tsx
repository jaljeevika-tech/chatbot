import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { BUSINESS_DEVELOPMENT_SUPPORT_UPLOAD } from './misUploadConfigs'

export function UploadBusinessDevelopmentSupportModal(props: MisUploadProps) {
  return <MisUploadModal config={BUSINESS_DEVELOPMENT_SUPPORT_UPLOAD} {...props} />
}
