// Owned, offline fixtures for host contracts. No upstream source code or service data.
const metadata = (name: string, itemType: number, langs = ['en']) =>
  `const mangayomiSources=${JSON.stringify([
    { id: 1, name, langs, version: '1.0.0', baseUrl: 'https://catalog.example', itemType },
  ])};`;

export const imageSource =
  metadata('Synthetic images', 0, ['ko', 'en']) +
  String.raw`class DefaultExtension extends MProvider {
    getSourcePreferences(){return [
      {key:'language',listPreference:{title:'Display language',entries:['English','Korean'],entryValues:['en','ko'],valueIndex:0}},
      {key:'original_languages',multiSelectListPreference:{title:'Filter original languages',entries:['Korean','Japanese'],entryValues:['originalLanguage[]=ko','originalLanguage[]=ja'],values:[]}}
    ];}
    async getPopular(page){return this.search('',page);}
    async search(query,page){
      const selected=new SharedPreferences().get('original_languages')||[];
      const url='https://catalog.example/works?title='+encodeURIComponent(query)+(selected.length?'&'+selected.join('&'):'');
      return JSON.parse((await new Client().get(url)).body);
    }
    async getDetail(url){
      const data=JSON.parse((await new Client().get('https://catalog.example'+url)).body);
      // Omitted names must preserve the title already obtained from the catalog.
      return {description:data.description,chapters:data.chapters};
    }
    async getPageList(url){return JSON.parse((await new Client().get('https://catalog.example'+url)).body).pages;}
  }`;

export const novelSource =
  metadata('Synthetic novel', 2) +
  String.raw`class DefaultExtension extends MProvider {
    getSourcePreferences(){throw new Error('getSourcePreferences not implemented');}
    getHeaders(){throw new Error('getHeaders not implemented');}
    async getPopular(){return JSON.parse((await new Client().get('https://catalog.example/works')).body);}
    async getDetail(url){
      const doc=new Document((await new Client().post('https://catalog.example'+url+'/chapters',{},{})).body);
      return {name:'Example novel',chapters:doc.select('a.chapter').map(a=>({name:a.text,url:a.attr('href')}))};
    }
    cleanHtmlContent(){throw new Error('already cleaned content must not be cleaned again');}
    async getHtmlContent(title,url){
      const doc=new Document((await new Client().get(url)).body);
      return [doc.selectFirst('h1').text,...doc.select('article p').map(p=>p.text)].join('\n\n');
    }
  }`;

export const orderedPagesSource = `class DefaultExtension extends MProvider {
  async getPopular(){
    const doc=new Document((await new Client().get('https://catalog.example/works')).body);
    return {list:doc.select('a.work').map(a=>({name:a.text,link:a.attr('href'),imageUrl:a.selectFirst('img').getSrc})),hasNextPage:!!doc.selectFirst('a.next').attr('href')};
  }
  async getPageList(url){
    const doc=new Document((await new Client().get('https://catalog.example/'+url)).body);
    const raw=doc.selectFirst('script').text;
    const payload=JSON.parse(raw.substringAfter('payload=').substringBeforeLast(';'));
    return payload.pages.sort((a,b)=>a.order-b.order).map(page=>({url:page.url,headers:{Referer:'https://catalog.example'}}));
  }
}`;
