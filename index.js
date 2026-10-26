const debug = require('debug')('extract-zip')
const { constants, createWriteStream, promises: fs } = require('fs')
const getStream = require('get-stream')
const path = require('path')
const { promisify } = require('util')
const stream = require('stream')
const yauzl = require('yauzl')

const openZip = promisify(yauzl.open)
const pipeline = promisify(stream.pipeline)

class Extractor {
  constructor (zipPath, opts) {
    this.zipPath = zipPath
    this.opts = opts
  }

  async extract () {
    debug('opening', this.zipPath, 'with opts', this.opts)

    this.zipfile = await openZip(this.zipPath, { lazyEntries: true })
    this.canceled = false

    return new Promise((resolve, reject) => {
      this.zipfile.on('error', err => {
        this.canceled = true
        reject(err)
      })
      this.zipfile.readEntry()

      this.zipfile.on('close', () => {
        if (!this.canceled) {
          debug('zip extraction complete')
          resolve()
        }
      })

      this.zipfile.on('entry', async entry => {
        /* istanbul ignore if */
        if (this.canceled) {
          debug('skipping entry', entry.fileName, { cancelled: this.canceled })
          return
        }

        debug('zipfile entry', entry.fileName)

        if (entry.fileName.startsWith('__MACOSX/')) {
          this.zipfile.readEntry()
          return
        }

        const destDir = path.dirname(path.join(this.opts.dir, entry.fileName))

        try {
          await fs.mkdir(destDir, { recursive: true })

          const canonicalDestDir = await fs.realpath(destDir)
          const relativeDestDir = path.relative(this.opts.dir, canonicalDestDir)

          if (relativeDestDir.split(path.sep).includes('..')) {
            throw new Error(`Out of bound path "${canonicalDestDir}" found while processing file ${entry.fileName}`)
          }

          await this.extractEntry(entry)
          debug('finished processing', entry.fileName)
          this.zipfile.readEntry()
        } catch (err) {
          this.canceled = true
          this.zipfile.close()
          reject(err)
        }
      })
    })
  }

  async checkPath (target, entry) {
    const relative = path.relative(this.opts.dir, target)
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Out of bound path "${target}" found while processing file ${entry.fileName}`)
    }

    // Resolve existing ancestors too: the target itself may not exist yet.
    let resolved
    try {
      resolved = await fs.realpath(target)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      // A dangling symlink is not a missing path and must not be followed.
      const stats = await fs.lstat(target).catch(err => {
        if (err.code !== 'ENOENT') throw err
      })
      if (stats && stats.isSymbolicLink()) {
        throw new Error(`Dangling symlink "${target}" found while processing file ${entry.fileName}`)
      }
      const parent = path.dirname(target)
      if (parent === target) throw err
      return path.join(await this.checkPath(parent, entry), path.basename(target))
    }
    const canonicalRelative = path.relative(this.opts.dir, resolved)
    if (path.isAbsolute(canonicalRelative) || canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`)) {
      throw new Error(`Out of bound path "${resolved}" found while processing file ${entry.fileName}`)
    }
    return resolved
  }

  async extractEntry (entry) {
    /* istanbul ignore if */
    if (this.canceled) {
      debug('skipping entry extraction', entry.fileName, { cancelled: this.canceled })
      return
    }

    if (this.opts.onEntry) {
      this.opts.onEntry(entry, this.zipfile)
    }

    const dest = path.join(this.opts.dir, entry.fileName)

    // convert external file attr int into a fs stat mode int
    const mode = (entry.externalFileAttributes >> 16) & 0xFFFF
    // check if it's a symlink or dir (using stat mode constants)
    const IFMT = 61440
    const IFDIR = 16384
    const IFLNK = 40960
    const symlink = (mode & IFMT) === IFLNK
    let isDir = (mode & IFMT) === IFDIR

    // Failsafe, borrowed from jsZip
    if (!isDir && entry.fileName.endsWith('/')) {
      isDir = true
    }

    // check for windows weird way of specifying a directory
    // https://github.com/maxogden/extract-zip/issues/13#issuecomment-154494566
    const madeBy = entry.versionMadeBy >> 8
    if (!isDir) isDir = (madeBy === 0 && entry.externalFileAttributes === 16)

    debug('extracting entry', { filename: entry.fileName, isDir: isDir, isSymlink: symlink })

    const procMode = this.getExtractedMode(mode, isDir) & 0o777

    // always ensure folders are created
    const destDir = isDir ? dest : path.dirname(dest)

    const mkdirOptions = { recursive: true }
    if (isDir) {
      mkdirOptions.mode = procMode
    }
    debug('mkdir', { dir: destDir, ...mkdirOptions })
    await fs.mkdir(destDir, mkdirOptions)
    if (isDir) return

    if (!symlink) {
      const existing = await fs.lstat(dest).catch(err => {
        if (err.code !== 'ENOENT') throw err
      })
      if (existing && existing.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symlink "${dest}"`)
      }
    }

    debug('opening read stream', dest)
    const readStream = await promisify(this.zipfile.openReadStream.bind(this.zipfile))(entry)

    if (symlink) {
      const link = await getStream(readStream)
      if (path.isAbsolute(link)) {
        throw new Error(`Absolute symlink target "${link}" found while processing file ${entry.fileName}`)
      }
      let target = await this.checkPath(path.dirname(dest), entry)
      // Resolve each component before applying '..', including existing symlinks.
      for (const component of link.split(path.sep)) {
        target = await this.checkPath(path.resolve(target, component), entry)
      }
      debug('creating symlink', link, dest)
      await fs.symlink(link, dest)
    } else {
      await pipeline(readStream, createWriteStream(dest, {
        mode: procMode,
        flags: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW
      }))
    }
  }

  getExtractedMode (entryMode, isDir) {
    let mode = entryMode
    // Set defaults, if necessary
    if (mode === 0) {
      if (isDir) {
        if (this.opts.defaultDirMode) {
          mode = parseInt(this.opts.defaultDirMode, 10)
        }

        if (!mode) {
          mode = 0o755
        }
      } else {
        if (this.opts.defaultFileMode) {
          mode = parseInt(this.opts.defaultFileMode, 10)
        }

        if (!mode) {
          mode = 0o644
        }
      }
    }

    return mode
  }
}

module.exports = async function (zipPath, opts) {
  debug('creating target directory', opts.dir)

  if (!path.isAbsolute(opts.dir)) {
    throw new Error('Target directory is expected to be absolute')
  }

  await fs.mkdir(opts.dir, { recursive: true })
  opts.dir = await fs.realpath(opts.dir)
  return new Extractor(zipPath, opts).extract()
}
