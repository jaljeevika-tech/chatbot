import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { EXPOSURE_VISIT_UPLOAD } from './misUploadConfigs'

export function UploadExposureVisitModal(props: MisUploadProps) {
  return <MisUploadModal config={EXPOSURE_VISIT_UPLOAD} {...props} />
}
