import {$} from 'bun'
import fs from 'node:fs'
import google from '@googleapis/youtube'
import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'
import cliProgress from 'cli-progress'
import sanitizeFilename from 'sanitize-filename'
import {
  safeParse,
  parse,
  object,
  string,
  optional,
  array,
  minLength,
  mimeType,
} from 'valibot'

export type Video = {
  /** listApi.snippet.resourceId.videoId */
  id: string
  /** listApi.snippet.title */
  title: string
  /** listApi.snippet.description */
  description: string
  /** listApi.snippet.videoOwnerChannelId */
  channelId: string
  /** listApi.snippet.videoOwnerChannelTitle */
  channelName: string
  /** listApi.contentDetails.videoPublishedAt */
  dateCreated: string
  /** listApi.snippet.publishedAt */
  dateAddedToPlaylist: string
  /** listApi.snippet.thumbnails[maxres | standard | high | medium | default].url */
  thumbnailUrl: string | null
  /** videosApi.contentDetails.duration */
  durationInSeconds: number
  /** Constructed from `id` - URL to the video */
  url: string
  /** Constructed from `channelId` - URL to the video owner's channel */
  channelUrl: string | null
  /** Derived from yt-dlp */
  audioFileExtension: string | null
  /** Derived from yt-dlp */
  videoFileExtension: string | null
  /** Derived from the listApi missing certain fields */
  isUnavailable: boolean
}

type PartialVideo = Omit<
  Video,
  'durationInSeconds' | 'audioFileExtension' | 'videoFileExtension'
>

type PartialVideoWithDuration = PartialVideo & Pick<Video, 'durationInSeconds'>

export type DownloadType = 'audio' | 'video' | 'both' | 'none'

/**
 * This schema is used to parse the response from the YouTube
 * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems).
 * Optional properties are marked as so to accommodate videos no longer
 * available.
 */
const PlaylistItemSchema = object({
  snippet: object({
    resourceId: object({
      videoId: string(), // id
    }),
    title: string(),
    description: string(),
    videoOwnerChannelId: optional(string(), ''), // channelId
    videoOwnerChannelTitle: optional(string(), ''), // channelName
    publishedAt: string(), // dateAddedToPlaylist

    // thumbnailUrl
    thumbnails: object({
      maxres: optional(object({url: string()})),
      standard: optional(object({url: string()})),
      high: optional(object({url: string()})),
      medium: optional(object({url: string()})),
      default: optional(object({url: string()})),
    }),
  }),
  contentDetails: object({
    videoPublishedAt: optional(string(), ''), // dateCreated
  }),
})

const VideosListItemSchema = object({
  id: string(),
  contentDetails: object({
    duration: string(),
  }),
})

const YtDlpJsonSchema = object({
  ext: string(), // Video file extension.
  requested_downloads: array(
    object({
      ext: string(), // Audio file extension.
    }),
    [minLength(1)]
  ),
})

export async function downloadYouTubePlaylist({
  playlistId,
  youTubeApiKey,
  directory,
  downloadType,
  audioFormat = 'mp3',
  videoFormat = 'mp4',
  downloadThumbnails = false,
  maxDurationSeconds = Infinity,
  mostRecentItemsCount,
  silent = false,
  maxConcurrentFetchCalls = 4,
  maxConcurrentYtdlpCalls = 10,
}: {
  /** YouTube playlist id. */
  playlistId: string

  /**
   * YouTube API key. This will be used to fetch all metadata for videos in the
   * playlist.
   */
  youTubeApiKey: string

  /**
   * The absolute path to where the data should be stored. Sub-folders will be
   * created as needed. The folder structure will be:
   *
   * - `<directory>/metadata.json` - an array of objects (`Video[]`)
   * - `<directory>/audio` - contains the audio files
   * - `<directory>/video` - contains the video files
   * - `<directory>/thumbnails` - contains the jpg thumbnail files
   */
  directory: string

  /**
   * `'none'`  - No files will be downloaded, including thumbnails. Only the
   *             `metadata.json` file will be written.
   *
   * `'audio'` - Download only audio files as determined by the `audioFormat`
   *             option. Defaults to `'mp3'`.
   *
   * `'video'` - Download only video files as determined by the `videoFormat`
   *             option. Defaults to `'mp4'`
   *
   * `'both'`  - Download audio and video files as determined by their
   *             corresponding format options.
   */
  downloadType: DownloadType

  /**
   * Optional - default value `'mp3'`
   *
   * A valid ffmpeg audio [format](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#format-selection) string.
   */
  audioFormat?: string

  /**
   * Optional - default value `'mp4'`
   *
   * A valid ffmpeg video [format](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#format-selection) string.
   */
  videoFormat?: string

  /**
   * Optional - default value `false`
   *
   * A boolean indicating wether to download a `.jpg` thumbnail for each video.
   * The highest resolution available will be downloaded. Only thumbnails for
   * new videos will be downloaded.
   */
  downloadThumbnails?: boolean

  /**
   * Optional - default value `Infinity`
   *
   * The maximum duration in seconds a playlist item can be to be downloaded.
   */
  maxDurationSeconds?: number

  /**
   * Optional - default value `undefined`
   *
   * A _positive_ number (max of 50) indicating how many items in the playlist
   * to retrieve, starting with the most recent. Negative and invalid numbers
   * will be ignored. All items will be retrieved if no value is provided.
   *
   * I.e. `mostRecentItemsCount: 20` will only retrieve data for the most recent
   * 20 videos in the playlist. This option is useful when running in a cron job
   * to avoid fetching and parsing the entire list when you may already have a
   * substantial portion processed and downloaded already.
   */
  mostRecentItemsCount?: number

  /**
   * Optional - default value `false`
   *
   * Boolean indicating wether to silence all internal console.log's.
   */
  silent?: boolean

  /**
   * Options - default value `4`
   *
   * The number of concurrent fetch calls made to the YouTube
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list).
   */
  maxConcurrentFetchCalls?: number
  maxConcurrentYtdlpCalls?: number
}) {
  const log = silent ? () => {} : console.log
  const processStart = performance.now()

  /**
   * *********
   * STEP 1: *
   * *********
   * Check for system dependencies.
   *
   * yt-dlp is the package we use to download videos from a YouTube playlist.
   * ffmpeg is the package that yt-dlp uses under the hood to convert videos to
   * audio files. Check for both of these before proceeding and provide a
   * helpful message if any are missing. The process will exit with an error
   * without returning anything if dependencies are missing.
   */

  log('\n👉 Checking system dependencies...')

  const ytDlpPath = Bun.which('yt-dlp')
  const ffmpegPath = Bun.which('ffmpeg')
  const directoryExists = fs.existsSync(directory)

  if (ytDlpPath === null) {
    console.error('\nCould not find the `yt-dlp` package on this system.')
    console.error('This package is needed to download YouTube videos.')
    console.error(
      'Please head to https://github.com/yt-dlp/yt-dlp for download instructions.'
    )
  }

  if (ffmpegPath === null) {
    console.error('\nCould not find the `ffmpeg` package on this system.')
    console.error(
      'This package is needed to extract audio from YouTube videos.'
    )
    console.error(
      'You can download a binary at https://www.ffmpeg.org/download.html or run `brew install ffmpeg`.'
    )
  }

  if (!directoryExists) {
    console.error(
      '\n Could not find the directory provided. Please check the path or create it.'
    )
  }
  if (ytDlpPath === null || ffmpegPath === null || !directoryExists) {
    process.exit(1)
  }

  log('✅ System dependencies are present!')

  /**
   * *********
   * STEP 2: *
   * *********
   * Get metadata for each video.
   *
   * See comments on the `Video` type for where each field comes from in the
   * YouTube API. Depending on the input variables we will either fetch the
   * entire playlist or the most recent specified number of videos. This is
   * helpful when running in a cron job where we don't need to fetch the entire
   * playlist each time.
   */

  const yt = google.youtube({version: 'v3', auth: youTubeApiKey})
  const startFetchMetadata = performance.now()
  log(
    `\n👉 Getting partial video metadata for ${
      mostRecentItemsCount || 'all'
    } items...`
  )

  const playlistItemsResponses = await genPlaylistItems({
    yt,
    playlistId,
    mostRecentItemsCount,
  })
  const partialVideosMetadata: PartialVideo[] = playlistItemsResponses.reduce<
    PartialVideo[]
  >((acc, response) => {
    response.data.items?.forEach(item => {
      const isUnavailable =
        item.snippet?.title === 'Private video' ||
        item.snippet?.title === 'Deleted video'
      const results = safeParse(PlaylistItemSchema, item)

      // TODO - return issues in a consumable way
      if (!results.success) {
        console.log('\nRESPONSE:', item)

        results.issues.forEach((issue, i) => {
          console.log('\nISSUE', i + 1)
          console.log(issue)
        })

        throw new Error('Error parsing!')
      }

      const {snippet, contentDetails} = results.output

      acc.push({
        id: snippet.resourceId.videoId,
        title: sanitizeTitle(snippet.title),
        description: snippet.description,
        channelId: snippet.videoOwnerChannelId,
        channelName: snippet.videoOwnerChannelTitle,
        dateCreated: contentDetails.videoPublishedAt,
        dateAddedToPlaylist: snippet.publishedAt,
        thumbnailUrl:
          snippet.thumbnails.maxres?.url ??
          snippet.thumbnails.standard?.url ??
          snippet.thumbnails.high?.url ??
          snippet.thumbnails.medium?.url ??
          snippet.thumbnails.default?.url ??
          null,
        url: `https://www.youtube.com/watch?v=${snippet.resourceId.videoId}`,
        channelUrl: `https://www.youtube.com/channel/${snippet.videoOwnerChannelId}`,
        isUnavailable,
      })
    })

    return acc
  }, [])
  const partialVideosMetadataObj = partialVideosMetadata.reduce<
    Record<string, PartialVideo>
  >((acc, partialVideo) => {
    acc[partialVideo.id] = partialVideo
    return acc
  }, {})
  const videoIdsToFetch = partialVideosMetadata.map(({id}) => id)

  log(
    `👉 Getting remaining video metadata for ${pluralize(
      videoIdsToFetch.length,
      'item'
    )}...`
  )

  const chunkedVideoIdsToFetch = chunkArray(
    videoIdsToFetch,
    MAX_YOUTUBE_RESULTS * maxConcurrentFetchCalls // i.e. 200 ids
  )

  /**
   * Uses the YouTube
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * to fetch additional metadata for each video
   */
  const videosListResponses = await chunkedVideoIdsToFetch.reduce<
    Promise<GaxiosResponse<google.youtube_v3.Schema$VideoListResponse>[]>
  >((promise, ids) => {
    const idsForPromises = chunkArray(ids, maxConcurrentFetchCalls)

    /**
     * ⚠️ We call the VideosList API with a max of 50 ids each time. Private and
     * deleted videos will not show up in `repsonse.data.items` so that array
     * is not guaranteed to be the same size as our `id` array.
     */
    const promises = idsForPromises.map(idsForPromise => {
      return yt.videos.list({id: idsForPromise, part: ['contentDetails']})
    })

    return promise.then(previousResults =>
      Promise.all(promises).then(results => previousResults.concat(results))
    )
  }, Promise.resolve([]))
  const durationsObj = videosListResponses.reduce<Record<string, number>>(
    (acc, response) => {
      response.data.items?.forEach(item => {
        const {id, contentDetails} = parse(VideosListItemSchema, item)
        const duration = contentDetails.duration
        const partialVideo = partialVideosMetadataObj[id]

        if (!partialVideo) {
          throw new Error(`No partial video found for ${id}`)
        }

        acc[id] = parseISO8601DurationToSeconds(duration)
      })

      return acc
    },
    {}
  )
  const partialVideosWithDurationMetadata: PartialVideoWithDuration[] =
    partialVideosMetadata.map(partialVideo => {
      const durationInSeconds = durationsObj[partialVideo.id] ?? 0
      return {...partialVideo, durationInSeconds}
    })

  const fetchMetadataTime = sanitizeTime(performance.now() - startFetchMetadata)
  log(`✅ Video metadata received! [${fetchMetadataTime}]`)

  /**
   * *********
   * STEP 3: *
   * *********
   * Determine which videos need to be downloaded.
   *
   * We compare our metadata to what we have on disk. Any available videos found
   * in the response data that are not found on disk are downloaded. If the
   * expected directories don't exist they will be created in a later step when
   * we save the videos.
   */

  const audioDir = `${directory}/audio`
  const videoDir = `${directory}/video`
  // 💡 Directories may now exist - they will be created at a later step.
  const [existingAudioIdsOnDiskSet, existingVideoIdsOnDiskSet] = [
    audioDir,
    videoDir,
  ].map(dir => {
    return new Set<string>(
      (() => {
        try {
          return fs.readdirSync(dir).reduce<string[]>((acc, item) => {
            const id = item.match(squareBracketIdRegex)?.[1]
            if (id) acc.push(id)

            return acc
          }, [])
        } catch {
          return []
        }
      })()
    )
  }) as [Set<string>, Set<string>]
  const potentialVideosToDownload = partialVideosWithDurationMetadata.filter(
    ({id, durationInSeconds, isUnavailable}) => {
      return (
        // The download type isn't 'none'...
        // downloadType !== 'none' &&
        // The video isn't too long...
        durationInSeconds <= maxDurationSeconds &&
        // The video isn't unavailable...
        !isUnavailable &&
        // The video hasn't already been downloaded...
        (!existingAudioIdsOnDiskSet.has(id) ||
          !existingVideoIdsOnDiskSet.has(id))
      )
    }
  )

  /**
   * *********
   * STEP 4: *
   * *********
   * Download the videos.
   *
   * We will create the directories needed conditionally.
   */

  // Create audio dir.
  if (downloadType === 'audio' || downloadType === 'both') {
    mkdirSafe(audioDir)
  }

  // Create video dir.
  if (downloadType === 'video' || downloadType === 'both') {
    mkdirSafe(videoDir)
  }

  const startProcessing = performance.now()
  const makeTemplate = (title: string, type: 'audio' | 'video') => {
    return `${directory}/${type}/${title} [%(id)s].%(ext)s`
  }
  const videoProgressBar = new cliProgress.SingleBar(
    {
      format: '👉 {bar} {percentage}% | {value}/{total} | {duration_formatted}',
      // barsize: Math.round(process.stdout.columns * 0.75),
      stopOnComplete: true,
    },
    cliProgress.Presets.shades_grey
  )

  /**
   * This contains the promise functions for the different download types. File
   * extensions are retrieved from yt-dlp's json and added to the metadata.
   */
  const downloadPromiseFxns = potentialVideosToDownload.reduce<
    (() => Promise<Video>)[]
  >((acc, partialVideo) => {
    const {id, title, url} = partialVideo
    const audioExistsOnDisk = existingAudioIdsOnDiskSet.has(id)
    const videoExistsOnDisk = existingVideoIdsOnDiskSet.has(id)
    const audioTemplate = makeTemplate(title, 'audio')
    const videoTemplate = makeTemplate(title, 'video')

    const bothPromiseFxn = () => {
      return $`yt-dlp -o "${videoTemplate}" --format="${videoFormat}" --extract-audio --audio-format="${audioFormat}" -k -J --no-simulate ${url}`
        .quiet()
        .then(({exitCode, stdout, stderr}) => {
          if (exitCode !== 0) {
            // TODO - do something with this error.
            throw new Error(stderr.toString())
          }

          const {ext: videoFileExtension, requested_downloads} = parse(
            YtDlpJsonSchema,
            JSON.parse(stdout.toString())
          )
          const audioFileExtension = requested_downloads[0]!.ext
          const oldAudioPath = `${videoDir}/${title} [${id}].${audioFileExtension}`
          const newAudioPath = `${audioDir}/${title} [${id}].${audioFileExtension}`

          fs.renameSync(oldAudioPath, newAudioPath)
          videoProgressBar.increment()

          return {...partialVideo, audioFileExtension, videoFileExtension}
        })
    }

    const videoPromiseFxn = () => {
      return $`yt-dlp -o "${videoTemplate}" --format="${videoFormat}" -J --no-simulate ${partialVideo.url}`
        .quiet()
        .then(({exitCode, stdout, stderr}) => {
          if (exitCode !== 0) {
            // TODO - do something with this error.
            throw new Error(stderr.toString())
          }

          const {ext: videoFileExtension} = parse(
            YtDlpJsonSchema,
            JSON.parse(stdout.toString())
          )

          videoProgressBar.increment()

          return {
            ...partialVideo,
            audioFileExtension: null,
            videoFileExtension,
          }
        })
    }

    const audioPromiseFxn = () => {
      return $`yt-dlp -o "${audioTemplate}" --extract-audio --audio-format="${audioFormat}" -J --no-simulate ${url}`
        .quiet()
        .then(({exitCode, stdout, stderr}) => {
          if (exitCode !== 0) {
            // TODO - do something with this error.
            throw new Error(stderr.toString())
          }

          const {requested_downloads} = parse(
            YtDlpJsonSchema,
            JSON.parse(stdout.toString())
          )

          videoProgressBar.increment()

          return {
            ...partialVideo,
            audioFileExtension: requested_downloads[0]!.ext,
            videoFileExtension: null,
          }
        })
    }

    const nonePromiseFxn = () => {
      videoProgressBar.increment()

      return Promise.resolve({
        ...partialVideo,
        audioFileExtension: null,
        videoFileExtension: null,
      })
    }

    if (downloadType === 'both') {
      if (audioExistsOnDisk && !videoExistsOnDisk) {
        acc.push(videoPromiseFxn)
      }

      if (!audioExistsOnDisk && videoExistsOnDisk) {
        acc.push(audioPromiseFxn)
      }

      if (!audioExistsOnDisk && !videoExistsOnDisk) {
        acc.push(bothPromiseFxn)
      }
    }

    if (downloadType === 'video' && !videoExistsOnDisk) {
      acc.push(videoPromiseFxn)
    }

    if (downloadType === 'audio' && !audioExistsOnDisk) {
      acc.push(audioPromiseFxn)
    }

    if (downloadType === 'none') {
      acc.push(nonePromiseFxn)
    }

    return acc
  }, [])

  const downloadVerb = downloadType === 'none' ? 'Processing' : 'Downloading'

  if (downloadPromiseFxns.length) {
    log(
      `\n👉 ${downloadVerb} ${pluralize(
        downloadPromiseFxns.length,
        'playlist item'
      )}...`
    )

    videoProgressBar.start(downloadPromiseFxns.length, 0)
  } else if (downloadType !== 'none') {
    log('\n✅ All videos accounted for, nothing to download!')
  }

  const promiseFxnBatches = chunkArray(
    downloadPromiseFxns,
    maxConcurrentYtdlpCalls
  )

  // TODO - use promise.allSettled instead to handle errors better.
  /**
   * The actual download!
   */
  const freshMetadata = await promiseFxnBatches.reduce<Promise<Video[]>>(
    (promise, promiseFxnBatch) => {
      return promise.then(previousResults =>
        Promise.all(promiseFxnBatch.map(fxn => fxn())).then(newResults =>
          previousResults.concat(newResults)
        )
      )
    },
    Promise.resolve([])
  )

  if (downloadPromiseFxns.length) {
    const processingTime = sanitizeTime(performance.now() - startProcessing)
    const errors = [] // TODO - do something with the errors.
    const errorMsg = errors.length
      ? ` ${pluralize(errors.length, 'error')}`
      : ''
    const icon = errors.length ? '💡' : '✅'

    log(`${icon} ${downloadVerb} complete!${errorMsg} [${processingTime}]`)
  }

  /**
   * *********
   * STEP 5: *
   * *********
   * Download the thumbnails.
   *
   * The thumbnails directory will be created if not present.
   */
  if (downloadThumbnails) {
    // Create the thumbnail directory if it doesn't exist.
    const thumbnailDirectory = `${directory}/thumbnails`
    mkdirSafe(thumbnailDirectory)

    const existingThumbnailIdsOnDiskSet = fs
      .readdirSync(thumbnailDirectory)
      .reduce<Set<string>>((set, item) => {
        // Remove file extension, adding the thumbnail id to the set.
        if (item.endsWith('.jpg')) {
          set.add(item.slice(0, -4))
        }

        return set
      }, new Set())

    const thumbnailsToDownload = potentialVideosToDownload.reduce<
      {url: string; id: string}[]
    >((acc, video) => {
      const {thumbnailUrl, id} = video

      if (!existingThumbnailIdsOnDiskSet.has(id) && thumbnailUrl) {
        acc.push({url: thumbnailUrl, id})
      }

      return acc
    }, [])

    const thumbnailsLength = thumbnailsToDownload.length

    if (thumbnailsLength) {
      const thumbnailProgressBar = new cliProgress.SingleBar(
        {
          format:
            '👉 {bar} {percentage}% | {value}/{total} | {duration_formatted}',
          // barsize: Math.round(process.stdout.columns * 0.75),
          stopOnComplete: true,
        },
        cliProgress.Presets.shades_grey
      )

      log(`\n👉 Downloading ${pluralize(thumbnailsLength, 'thumbnail')}...`)
      thumbnailProgressBar.start(thumbnailsLength, 0)

      const thumbnailPromiseBatches = chunkArray(
        thumbnailsToDownload,
        maxConcurrentFetchCalls
      )
      const startThumbnails = performance.now()

      await thumbnailPromiseBatches.reduce<Promise<void>>((promise, batch) => {
        return promise
          .then(() =>
            Promise.all(
              batch.map(({url, id}) =>
                downloadThumbnailFile({url, id, thumbnailDirectory}).then(
                  () => {
                    thumbnailProgressBar.increment()
                  }
                )
              )
            )
          )
          .then(() => {})
      }, Promise.resolve())

      log(
        `✅ Thumbnails downloaded! [${sanitizeTime(
          performance.now() - startThumbnails
        )}]`
      )
    } else {
      log('\n✅ All thumbnails accounted for, nothing to download!')
    }
  }

  /**
   * *********
   * STEP 6: *
   * *********
   * Update `metadata.json`
   *
   * We have a newly constructed
   */

  if (freshMetadata.length) {
    log('\n👉 Updating metadata.json...')

    let metadataItemsUpdated = 0
    const startUpdateMetadata = performance.now()
    const metadataJsonPath = `${directory}/metadata.json`
    const existingMetadata: Video[] = await Bun.file(metadataJsonPath)
      .json()
      .catch(() => []) // In case the file doesn't exist yet.

    // This object will be updated with any new video data we have.
    const existingMetadataObj = existingMetadata.reduce<Record<string, Video>>(
      (acc, video) => {
        acc[video.id] = video
        return acc
      },
      {}
    )

    freshMetadata.forEach(video => {
      const existingVideo = existingMetadataObj[video.id]

      if (existingVideo) {
        if (existingVideo.isUnavailable && !video.isUnavailable) {
          // Unavailable => available (replace with new video)
          existingMetadataObj[video.id] = video
          metadataItemsUpdated++
        } else if (!existingVideo.isUnavailable && video.isUnavailable) {
          // Available => unavailable (update existing video)
          existingVideo.isUnavailable = true
          metadataItemsUpdated++
        } else if (!existingVideo.isUnavailable && !video.isUnavailable) {
          const existingAudioExt = existingVideo.audioFileExtension
          const existingVideoExt = existingVideo.videoFileExtension

          // Videos exist in both sets - most likely a file extension change.
          existingVideo.audioFileExtension =
            video.audioFileExtension ?? existingVideo.audioFileExtension
          existingVideo.videoFileExtension =
            video.videoFileExtension ?? existingVideo.videoFileExtension

          if (
            existingAudioExt !== existingVideo.audioFileExtension ||
            existingVideoExt !== existingVideo.videoFileExtension
          ) {
            metadataItemsUpdated++
          }
        }
      } else {
        // New video.
        existingMetadataObj[video.id] = video
        metadataItemsUpdated++
      }
    })

    if (metadataItemsUpdated) {
      const sortedMetadata = Object.values(existingMetadataObj).sort((a, b) => {
        return (
          +new Date(b.dateAddedToPlaylist) - +new Date(a.dateAddedToPlaylist)
        )
      })

      await Bun.write(metadataJsonPath, JSON.stringify(sortedMetadata, null, 2))

      log(
        `✅ Updated ${pluralize(
          metadataItemsUpdated,
          'metadata item'
        )}! [${sanitizeTime(performance.now() - startUpdateMetadata)}]`
      )
    } else {
      log('✅ metadata.json already up to date!')
    }
  }

  log(
    `\n🚀 Process complete! [${sanitizeTime(performance.now() - processStart)}]`
  )
}

function mkdirSafe(dir: string) {
  try {
    fs.mkdirSync(dir)
  } catch {}
}

/**
 * Converts a number of milliseconds into a plain-english string, such as
 * "4 minutes 32 seconds"
 */
function sanitizeTime(ms: number): string {
  const totalSeconds = ms / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = sanitizeDecimal(totalSeconds % 60)
  const secondsFinalValue = pluralize(seconds, 'second')

  return minutes
    ? `${pluralize(minutes, 'minute')} ${secondsFinalValue}`
    : secondsFinalValue
}

function sanitizeDecimal(num: number): string {
  return (
    num
      .toFixed(2)
      /**
       * `(\.\d*?)` - captures the decimal point `\.` followed by zero or more
       *              digits `\d*`, but it does so non-greedily due to the `?`
       *              after the `*`. This means it captures the smallest possible
       *              sequence of digits after the decimal point. This part is
       *              enclosed in parentheses to create a capturing group. The
       *              captured content will be referred to as `$1` in the
       *              replacement string.
       * `0*$`      - This part matches zero or more zeros `0*` that appear at the
       *              end of the string `$`.
       * `'$1'`     - Refers to the content captured by the first capturing group.
       */
      .replace(/(\.\d*?)0*$/, '$1')
      /**
       * `\.$`      - Remove any trailing period that might be present after the
       *              zeros are removed. It matches a period at the end of the
       *              string and replaces it with an empty string.
       */
      .replace(/\.$/, '')
  )
}

function pluralize(amount: number | string, word: string): string {
  const s = +amount === 1 ? '' : 's'
  return `${amount} ${word}${s}`
}

/**
 * Uses the YouTube
 * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
 * to fetch metadata on videos.
 *
 * This function intentionally doesn't massage the API responses and leaves that
 * responsibility up to consumers for cleaner, more predictable code.
 */
async function genPlaylistItems({
  yt,
  playlistId,
  mostRecentItemsCount,
  pageToken,
  results = [],
  resultsCount = 0,
}: {
  /** The YouTube API class used to make the fetch calls. */
  yt: youtube_v3.Youtube

  /** Playlist id. */
  playlistId: string

  /** Maximum number of videos to fetch from the API. */
  mostRecentItemsCount?: number

  /**
   * NOT meant to be specified in the initial call.
   *
   * Will be provided in recursive calls. A value returned by the API indicating
   * there are more results to be fetched.
   */
  pageToken?: string

  /**
   * NOT meant to be specified in the initial call.
   *
   * Will be provided in resursive calls. An array retaining all API responses.
   */
  results?: Awaited<
    GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>
  >[]
  resultsCount?: number
}): Promise<
  GaxiosResponse<google.youtube_v3.Schema$PlaylistItemListResponse>[]
> {
  /**
   * The maximum value the API can take is 50. By calculating `maxResults` each
   * time, we avoid over-fetching data.
   */
  const maxResults = mostRecentItemsCount
    ? mostRecentItemsCount - resultsCount
    : MAX_YOUTUBE_RESULTS
  const apiResponse = await yt.playlistItems.list({
    playlistId,
    part: ['contentDetails', 'snippet'],
    maxResults,
    pageToken,
  })

  const nextPageToken = apiResponse.data.nextPageToken
  const updatedResults = results.concat(apiResponse)
  const updatedResultsCount =
    resultsCount + (apiResponse.data.items?.length ?? 0)

  if (
    nextPageToken &&
    (mostRecentItemsCount ? updatedResultsCount < mostRecentItemsCount : true)
  ) {
    return genPlaylistItems({
      yt,
      playlistId,
      mostRecentItemsCount,
      results: updatedResults,
      resultsCount: updatedResultsCount,
      pageToken: nextPageToken,
    })
  }

  return updatedResults
}

function parseISO8601DurationToSeconds(durationString: string) {
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

async function downloadThumbnailFile({
  url,
  id,
  thumbnailDirectory,
}: {
  url: string
  id: string
  thumbnailDirectory: string
}) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {'Content-Type': 'image/jpeg'},
  })

  if (!res.ok) {
    console.log('NOPE!')
    throw new Error('Network response for thumbnail was not ok')
  }

  return Bun.write(`${thumbnailDirectory}/${id}.jpg`, res)
}

/**
 * This regex pattern matches a square bracket followed by one or more
 * alphanumeric characters or the special characters `-` and `_`, followed
 * by a closing square bracket. The .\w+$ part matches the file extension
 * and ensures that the match is at the end of the file name.
 *
 * Here's a step-by-step explanation of the regex pattern:
 * 1. `\[` - Matches a literal opening square bracket
 * 2. `(` - Starts a capturing group
 * 3. `[a-zA-Z0-9_-]` - Matches any alphanumeric character or the special characters `-` and `_`
 * 4. `+` - Matches one or more of the preceding characters
 * 5. `)` - Ends the capturing group
 * 6. `\]` - Matches a literal closing square bracket
 * 7. `\.` - Matches a literal dot
 * 8. `\w+` - Matches one or more word characters (i.e., the file extension)
 * 9. `$` - Matches the end of the string
 *
 * Thanks to perplexity.ai for generating this regex!
 */
const squareBracketIdRegex = /\[([a-zA-Z0-9_-]+)\]\.\w+$/

const MAX_YOUTUBE_RESULTS = 50

function chunkArray<T>(arr: T[], size: number): T[][] {
  return Array.from({length: Math.ceil(arr.length / size)}, (v, i) =>
    arr.slice(i * size, i * size + size)
  )
}

function sanitizeTitle(str: string): string {
  const safeTitle = sanitizeFilename(str, {replacement: ' '})

  // Use a regular expression to replace consecutive spaces with a single space.
  return safeTitle.replace(/\s+/g, ' ')
}

type CategoryInfo = {
  totalSize: number
  files: {file: string; id: string}[]
}

export function getStats(directory: string) {
  const {audioData, videoData, thumbnailData} = [
    `${directory}/audio`,
    `${directory}/video`,
    `${directory}/thumbnails`,
  ].reduce<{
    audioData: CategoryInfo
    videoData: CategoryInfo
    thumbnailData: CategoryInfo
  }>(
    (acc, dir) => {
      if (!fs.existsSync(dir)) return acc

      fs.readdirSync(dir).forEach(file => {
        const id = file.match(squareBracketIdRegex)?.[1]
        const bunFile = Bun.file(`${dir}/${file}`)
        const type = bunFile.type.split('/')[0]

        if (id) {
          if (type === 'audio') {
            acc.audioData.files.push({file, id})
            acc.audioData.totalSize += bunFile.size
          }

          if (type === 'video') {
            acc.videoData.files.push({file, id})
            acc.videoData.totalSize += bunFile.size
          }
        }

        if (type === 'image') {
          acc.thumbnailData.files.push({file, id: file.slice(0, -4)})
          acc.thumbnailData.totalSize += bunFile.size
        }
      }, [])

      return acc
    },
    {
      thumbnailData: {totalSize: 0, files: []},
      audioData: {totalSize: 0, files: []},
      videoData: {totalSize: 0, files: []},
    }
  )

  return [
    {
      type: 'audio',
      totalSize: audioData.totalSize,
      fileCount: audioData.files.length,
    },
    {
      type: 'video',
      totalSize: videoData.totalSize,
      fileCount: videoData.files.length,
    },
    {
      type: 'thumbnail',
      totalSize: thumbnailData.totalSize,
      fileCount: thumbnailData.files.length,
    },
  ]
    .sort((a, b) => {
      return b.totalSize - a.totalSize
    })
    .map(({totalSize, ...rest}) => {
      return {...rest, totalSize: bytesToSize(totalSize)}
    })
}

function bytesToSize(bytes: number): string {
  if (bytes >= 1073741824) {
    return sanitizeDecimal(bytes / 1073741824) + ' GB'
  } else if (bytes >= 1048576) {
    return sanitizeDecimal(bytes / 1048576) + ' MB'
  } else if (bytes >= 1024) {
    return sanitizeDecimal(bytes / 1024) + ' KB'
  } else if (bytes > 1) {
    return bytes + ' bytes'
  } else if (bytes == 1) {
    return bytes + ' byte'
  } else {
    return '0 bytes'
  }
}
