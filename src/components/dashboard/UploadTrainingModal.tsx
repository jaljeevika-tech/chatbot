import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { TRAINING_UPLOAD } from './misUploadConfigs'

export function UploadTrainingModal(props: MisUploadProps) {
  return <MisUploadModal config={TRAINING_UPLOAD} {...props} />
}
