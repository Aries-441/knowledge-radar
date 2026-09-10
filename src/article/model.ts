export type Article = {
  title: string;
  body: string;
  sourceUrl: string;
};

export type ArticleLoader = (url: string) => Promise<Article>;
