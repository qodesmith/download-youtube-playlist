import fs from 'node:fs'

export type DownloadType = 'audio' | 'video' | 'both'

/**
 * Creates a folder with the playlist name and a few sub-folders conditionlly:
 *
 * - `{playlistName}/audio`
 * - `{playlistName}/video`
 * - `{playlistName}/thumbnails`
 */
export function createFolders({
  directory,
  playlistName,
  downloadType,
  downloadThumbnails,
}: {
  directory: string
  playlistName: string
  downloadType: DownloadType
  downloadThumbnails?: boolean
}) {
  const folderNames = {
    playlist: `${directory}/${playlistName}`,
    audio: `${directory}/${playlistName}/audio`,
    video: `${directory}/${playlistName}/video`,
    thumbnails: `${directory}/${playlistName}/thumbnails`,
  }

  createFolderSafely(folderNames.playlist)

  if (downloadType === 'audio' || downloadType === 'both') {
    createFolderSafely(folderNames.audio)
  }

  if (downloadType === 'video' || downloadType === 'both') {
    createFolderSafely(folderNames.video)
  }

  if (downloadThumbnails) {
    createFolderSafely(folderNames.thumbnails)
  }

  return folderNames
}

function createFolderSafely(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir)
  }
}

export type Video = {
  // playlistResponse.data.items[number].snippet.resourceId.videoId
  id: string

  // playlistResponse.data.items[number].snippet.title
  title: string

  // playlistResponse.data.items[number].snippet.videoOwnerChannelId
  channelId: string

  // playlistResponse.data.items[number].snippet.videoOwnerChannelTitle
  channelName: string

  // playlistResponse.data.items[number].snippet.publishedAt
  dateAddedToPlaylist: string

  // videosListResponse.data.items[number].contentDetails.duration
  durationInSeconds: number | null

  /**
   * This value will be changed to `true` when future API calls are made and the
   * video is found to be unavailable. This will allow us to retain previously
   * fetch metadata.
   */
  isUnavailable?: boolean

  // This gets constructed based on the id - https://youtube.com/watch?v=${id}
  url: string

  // playlistResponse.data.items[number].snippet.thumbnails.maxres.url
  thumbnaillUrl: string

  // Absolute path to where the downloaded thumbnail jpg lives.
  thumbnailPath: string

  // videosListResponse.data.items[number].snippet.publishedAt
  dateCreated: string

  // Absolute path to where the downloaded audio mp3 lives.
  mp3Path?: string | null

  // Absolute path to where the downloaded video mp4 lives.
  mp4Path?: string | null
}

export type PartialVideo = Omit<Video, 'durationInSeconds' | 'dateCreated'>

export function chunkArray<T>(arr: T[], size: number): T[][] {
  return Array.from({length: Math.ceil(arr.length / size)}, (v, i) =>
    arr.slice(i * size, i * size + size)
  )
}

export function parseISO8601Duration(
  durationString: string | undefined | null
) {
  if (!durationString) return null

  const regex =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/
  const matches = durationString.match(regex) ?? []
  const years = matches[1] ? parseInt(matches[1]) : 0
  const months = matches[2] ? parseInt(matches[2]) : 0
  const weeks = matches[3] ? parseInt(matches[3]) : 0
  const days = matches[4] ? parseInt(matches[4]) : 0
  const hours = matches[5] ? parseInt(matches[5]) : 0
  const minutes = matches[6] ? parseInt(matches[6]) : 0
  const seconds = matches[7] ? parseFloat(matches[7]) : 0
  const totalSeconds =
    years * 31536000 +
    months * 2592000 +
    weeks * 604800 +
    days * 86400 +
    hours * 3600 +
    minutes * 60 +
    seconds

  return totalSeconds
}
