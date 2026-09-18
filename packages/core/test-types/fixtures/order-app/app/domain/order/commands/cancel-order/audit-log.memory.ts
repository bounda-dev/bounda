export default {
  entries: [] as string[],
  record(entry: string): void {
    this.entries.push(entry);
  },
};
