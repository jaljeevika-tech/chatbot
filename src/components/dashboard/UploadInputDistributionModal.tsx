import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { INPUT_DISTRIBUTION_UPLOAD } from './misUploadConfigs'

export function UploadInputDistributionModal(props: MisUploadProps) {
  return <MisUploadModal config={INPUT_DISTRIBUTION_UPLOAD} {...props} />
}
