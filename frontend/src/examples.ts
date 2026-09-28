import type { Lang } from "./types";

// These are interface demos written for this project. They are not labeled benchmark samples.
export const EXAMPLES: { id: string; label: string; lang: Lang; text: string; note: string }[] = [
  {
    id: "en",
    label: "英文演示",
    lang: "en",
    note: "演示文本，用于体验检测流程，不代表已知的人写或 AI 标签。",
    text: "Last autumn I helped our neighborhood library sort boxes of donated books. I expected a quiet afternoon, but every box held a small surprise: a recipe card tucked into a cookbook, a name written inside a novel, or a ticket used as a bookmark. I began asking the volunteers where the books had come from. Their answers made the library feel less like a storage room and more like a record of people who had lived nearby.\n\nBy the end of the day, we had filled three shelves. I went home thinking about the notes readers leave for one another without realizing it.",
  },
  {
    id: "zh",
    label: "中文演示",
    lang: "zh",
    note: "演示文本，用于体验检测流程，不代表已知的人写或 AI 标签。",
    text: "上周我去社区图书馆帮忙整理捐赠的旧书。本来以为只是把书按类别摆好，结果每打开一个箱子都能看到一点意外：菜谱里夹着手写配方，小说扉页上写着旧主人的名字，还有人拿车票当书签。我一边分类，一边听志愿者讲这些书是怎么来到这里的。\n\n等我们把三排书架摆满，我才发现自己记住的不是书的数量，而是藏在纸页里的生活痕迹。回家的路上，我还在想一本旧书会怎样被下一个读者重新理解。",
  },
  {
    id: "bi",
    label: "中英混合演示",
    lang: "bi",
    note: "演示中英分开检测；两种语言各自出结果，不合成一个 AI 比例。",
    text: "This short abstract describes how a small community library organized donated books and invited local volunteers to help. It focuses on the stories readers leave inside old books, and on how those details shaped the writer's understanding of the place.\n\n这篇短文记录了一次整理旧书的经历。作者在分类时注意到夹在书里的纸条、书签和名字，也听志愿者讲了这些书的来历。整理结束后，作者重新思考了图书馆与周围居民的关系。",
  },
];
