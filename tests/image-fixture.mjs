// Synthetic 1×1 raster; Wikimedia responses in unit tests are explicit fixtures.
export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
export const request = { id: 'photo', wikipediaTitle: 'Fixture article', language: 'en', alt: 'Synthetic test pixel, not a destination photograph' }
export const original = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Fixture.png'
export const thumbnail = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Fixture.png/640px-Fixture.png'
export const image = { ...request, status: 'available', dataUrl: 'data:image/png;base64,' + png, imageUrl: thumbnail,
  articleUrl: 'https://en.wikipedia.org/wiki/Fixture%20article', creditUrl: 'https://commons.wikimedia.org/wiki/File:Fixture.png', creator: 'Synthetic fixture author', license: 'CC0' }
export const document = { version: 3, title: 'Synthetic image fixture', description: 'Controlled offline test, no real attribution claim',
  height: 300, html: '<input id="value" value="7"><figure data-iui-image="photo"></figure>', css: '', javascript: 'window.activations=(window.activations||0)+1;', images: [image] }
