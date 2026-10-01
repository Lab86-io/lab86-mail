/**
 * Open comments are anchored to text. An edit of that text can detach the
 * comment from it, and the semantic editor does not show comments, so a Doc
 * with an open anchored comment opens as a preview. The Drive comments list
 * works with the `drive.readonly` scope that a Drive connection already has.
 */
const MAX_COMMENT_PAGES = 20;

export async function googleDocHasOpenComments(
  getJson: (endpoint: string) => Promise<any>,
  fileId: string,
): Promise<boolean> {
  let pageToken = '';
  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const params = new URLSearchParams({
      fields: 'comments(resolved,deleted,anchor),nextPageToken',
      pageSize: '100',
      includeDeleted: 'false',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const payload = await getJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/comments?${params}`,
    );
    const comments = Array.isArray(payload?.comments) ? payload.comments : [];
    if (comments.some((comment: any) => !comment?.resolved && !comment?.deleted && comment?.anchor))
      return true;
    pageToken = typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : '';
    if (!pageToken) return false;
  }
  // Too many pages to read in full: treat the Doc as commented.
  return true;
}
