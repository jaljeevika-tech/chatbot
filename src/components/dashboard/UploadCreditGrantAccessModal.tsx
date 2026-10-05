import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { CREDIT_GRANT_ACCESS_UPLOAD } from './misUploadConfigs'

export function UploadCreditGrantAccessModal(props: MisUploadProps) {
  return <MisUploadModal config={CREDIT_GRANT_ACCESS_UPLOAD} {...props} />
}
