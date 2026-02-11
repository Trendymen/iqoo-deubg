import { stringify } from 'csv-stringify/sync';

export function toCsv(records, columns = null) {
  return stringify(records, {
    header: true,
    columns: columns || undefined
  });
}
