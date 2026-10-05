import { MisUploadModal, type MisUploadProps } from './MisUploadModal'
import { COMMUNITY_MEETING_UPLOAD } from './misUploadConfigs'

export function UploadCommunityMeetingModal(props: MisUploadProps) {
  return <MisUploadModal config={COMMUNITY_MEETING_UPLOAD} {...props} />
}
