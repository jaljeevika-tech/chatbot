import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { INCOME_UPLOAD } from './misUploadConfigs'

export function UploadIncomeModal(props: MisUploadProps) {
  return <MisUploadModal config={INCOME_UPLOAD} {...props} />
}
