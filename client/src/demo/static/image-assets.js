// Sample images are bundled as hashed assets so the static preview needs no file server.
const modules = import.meta.glob('../../../../demo/samples/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})

const urlsByFilename = new Map(
  Object.entries(modules).map(([path, url]) => [path.split('/').pop(), url]),
)

export function sampleImageUrl(filename) {
  return urlsByFilename.get(filename) ?? null
}
