import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { SCHEME_ACCESS_UPLOAD } from './misUploadConfigs'

export function UploadSchemeAccessModal(props: MisUploadProps) {
  return <MisUploadModal config={SCHEME_ACCESS_UPLOAD} {...props} />
}
