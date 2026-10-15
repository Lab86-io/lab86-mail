import content from './content.json';
import { parseProductUpdates } from './model';

// Version-controlled notes ship with the app. Loading the feed never needs an AI call or GitHub access.
export const PRODUCT_UPDATES = parseProductUpdates(content);
