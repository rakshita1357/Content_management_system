export const FOLDER = 'application/vnd.google-apps.folder';
export const ROOT_ID = 'ROOT_FOLDER_1234567890';

export function sampleDrive() {
  return {
    root: [
      { id: 'fold_b', name: 'Monsoon sale', mimeType: FOLDER, createdTime: '2026-09-02T10:00:00Z' },
      { id: 'fold_a', name: 'Diwali offer', mimeType: FOLDER, createdTime: '2026-09-01T10:00:00Z' },
      { id: 'json1', name: 'ads.json', mimeType: 'application/json', createdTime: '2026-09-01T00:00:00Z' },
      { id: 'stray', name: 'notes.txt', mimeType: 'text/plain', createdTime: '2026-09-01T00:00:00Z' },
    ],
    children: new Map([
      ['fold_a', [
        { id: 'vid1', name: 'diwali.mp4', mimeType: 'video/mp4', size: '52428800', md5Checksum: 'aa', createdTime: '2026-09-03T09:00:00Z', modifiedTime: '2026-09-03T09:00:00Z', videoMediaMetadata: { width: 1920, height: 1080, durationMillis: '30500' } },
        { id: 'doc1', name: 'brief.pdf', mimeType: 'application/pdf', size: '100', createdTime: '2026-09-03T09:00:00Z' },
      ]],
      ['fold_b', [
        { id: 'img1', name: 'poster.jpg', mimeType: 'image/jpeg', size: '400000', md5Checksum: 'bb', createdTime: '2026-09-02T12:00:00Z', modifiedTime: '2026-09-02T12:00:00Z', imageMediaMetadata: { width: 1920, height: 1080 } },
        { id: 'vid2', name: 'new.mp4', mimeType: 'video/mp4', size: '1000', createdTime: '2026-09-04T12:00:00Z', modifiedTime: '2026-09-04T12:00:00Z' },
        { id: 'sub1', name: 'old', mimeType: FOLDER, createdTime: '2026-09-02T12:00:00Z' },
      ]],
    ]),
  };
}
