const Q = require('q')
const sleep = require('system-sleep')
const co = require('co')
const coRequest = require('co-request').defaults({jar: true})
const cheerio = require('cheerio')
const iconv = require('iconv-lite')
const db = require('./db')
const fs = require('fs-extra')
const path = require('path')

const Scrapper = {
  vars: {
    realStateTypes: db.getSetting('property_types'),
    realStateCityId: db.getSetting('city_id'), // city of Maringá
    realStateUrlSearch: db.getSetting('search_url'),
    realStateList: db.get('real_state_list').value()
  },
  init () {},
  process () {
    co(function* () {
      let generalResult = []
      let deferred = Q.defer()
      for (let i = 0; i < Scrapper.vars.realStateTypes.length; i++) {
        let response
        let pages = []
        let type = Scrapper.vars.realStateTypes[i]
        let baseUrl = `${Scrapper.vars.realStateUrlSearch}/${type}/${Scrapper.vars.realStateCityId}/ordem-imoveis.valor`

        console.log('-'.repeat(100))
        console.log('Processing Type =>', type)
        try {
          response = yield Scrapper.makeRequest(baseUrl + '/pag-0')
        } catch (err) {
          console.error('-'.repeat(100))
          console.error('ERROR: ', err.message)
          console.error(err.stack)
          console.error('-'.repeat(100))
          process.exit(1)
        }

        let body = response.body
        let processedBody = iconv.decode(Buffer.concat(new Array(body)), 'latin1').toString()
        let $ = cheerio.load(processedBody)

        let pageTotal = $('.resultados_paginacao_descricao').text().match(/P.gina 1 de (\d*)/)[1] || false
        if (!pageTotal) {
          throw new Error('No results')
        }

        console.log('Total pages =>', pageTotal)
        for (let i = 1; i < pageTotal; i++) {
          pages.push(i)
        }

        console.log('Processing page => 1')
        let result = Scrapper.processResponse(body)
        generalResult = generalResult.concat(result || [])
        console.log('done processing page => 1 - results found =>', result.length, ' - total =>', generalResult.length)

        for (let i = 0; i < pages.length; i++) {
          let page = pages[i]

          console.log('Processing page =>', page + 1)
          try {
            response = yield Scrapper.makeRequest(baseUrl + `/pag-${page}`)
          } catch (err) {
            console.error('-'.repeat(100))
            console.error('ERROR: ', err.message)
            console.error(err.stack)
            console.error('-'.repeat(100))
            process.exit(1)
          }
          result = Scrapper.processResponse(response.body)
          generalResult = generalResult.concat(result || [])

          console.log('done processing page =>', page + 1, ' - results found =>', result.length, ' - total =>', generalResult.length)
          sleep(500)
        }
        console.log('Done processing Type => ', type)

        sleep(1000)
      }

      deferred.resolve(generalResult)

      return deferred.promise
    }).then(result => {
      result = Scrapper.processResult(result)

      db.set('properties', result || []).value()
      db.setSetting('updated_at', Date.now())

      sleep(1000)

      try {
        let webDbFile = path.join(__dirname, '../web/app/data/db.json')
        if (!fs.existsSync(path.dirname(webDbFile)) && fs.mkdirsSync(path.dirname(webDbFile))) {
          throw new Error('Error crating destination directory for web database.')
        }

        let webDb = Object.assign({}, {
          properties: db.get('properties').value(),
          real_state_list: db.get('real_state_list').value(),
          updated_at: db.getSetting('updated_at')
        })

        fs.writeFileSync(webDbFile, JSON.stringify(webDb))
      } catch (err) {
        console.error('-'.repeat(100))
        console.error('ERROR: ', err.message)
        console.error(err.stack)
        console.error('-'.repeat(100))
        process.exit(1)
      }

      console.log('Processing complete.')
    })
  },
  *makeRequest (url, callback) {
    return coRequest({
      followRedirect: true,
      followAllRedirects: true,
      maxRedirects: 3,
      uri: url,
      encoding: null,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh Intel Mac OS X 10_12_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/57.0.2934.0 Safari/537.36'
      }
    })
  },
  processResponse (body) {
    let processedBody = iconv.decode(Buffer.concat(new Array(body)), 'latin1').toString()

    let $ = cheerio.load(processedBody)

    let result = $('.resultados_imoveis')
    if (!result.length) {
      console.log('-'.repeat(100))
      console.error('No results found')
      console.log('Page output', $('.estrutura_conteudo').html())
      console.log('-'.repeat(100))
      result = []
    }

    return result.filter(function (i) {
      let item = $(this)
      let realStateId = item.find('.resultados_imoveis_listadescricao.resultados_imoveis_border .link_cinza11').attr('href').match(/imobiliaria\/(\d+)/i)[1] || 0

      realStateId = Number(realStateId)
      if (!realStateId || isNaN(realStateId)) {
        return false
      }

      return Scrapper.vars.realStateList.filter(item => item.id === realStateId).length > 0
    }).map((i, element) => {
      return $('<div />').append(element).html()
    }).get()
  },
  processResult (result) {
    console.log('-'.repeat(100))
    console.log('Processing total of ', result.length, ' results...')

    try {
      result = result.map(item => {
        let $ = cheerio.load(item)

        let location = $('.resultados_imoveis_listatitulo .texto_laranja12').text() || ''
        let street = $('.resultados_imoveis_listatitulo').contents()[6] || ''
        let type = $('.resultados_imoveis_listadescricao').eq(0).find('.texto_cinza12').eq(0).text() || ''
        let price = $('.resultados_imoveis_listadescricao').eq(0).find('.texto_cinza18').text() || ''
        let dealer = $('.resultados_imoveis_listadescricao.resultados_imoveis_border').find('.texto_cinza12').text() || ''
        let url = $('.resultados_imoveis_listadescricao.resultados_imoveis_border').find('.link_botao').attr('href') || ''
        let picture = $('.resultados_imoveis_colunafoto .resultados_imoveis_listafoto img').attr('src') || ''
        let id = Number(/\/imoveis\/(\d+)\//.test(url) ? url.match(/\/imoveis\/(\d+)\//)[1] : 0)

        let roomsBlock = $('.resultados_imoveis_listadescricao').eq(0).text() || ''
        let rooms = 0
        let suites = 0

        street = street ? street.data.toString().trim() : ''
        try {
          suites = Number(/(\d+) su.te/.test(roomsBlock) ? roomsBlock.match(/(\d+) su.te/)[1] : 0)
          rooms = Number(/(\d+) quarto/.test(roomsBlock) ? roomsBlock.match(/(\d+) quarto/)[1] : 0)
        } catch (err) {
          console.error('-'.repeat(100))
          console.error('ERROR: ', err.message)
          console.error(err.stack)
          console.error('-'.repeat(100))
          console.log(roomsBlock)
          process.exit(1)
        }

        return {
          id,
          type,
          picture,
          location,
          street,
          price,
          rooms: suites + rooms,
          dealer,
          url
        }
      })

      result = result.map(JSON.stringify).reverse()
        .filter((item, index, arr) => arr.indexOf(item, index + 1) === -1)
        .reverse().map(JSON.parse)
        .filter(item => (item.price || false) && !/consulte/i.test(item.price) && item.rooms > 0)
        .map(item => {
          let realState = Scrapper.findRealStateByName(item.dealer)

          item.price = Number(item.price.replace(/R\$ /, '').replace('.', '').replace(',', '.')) || 0
          item.dealer = realState ? realState.id : 0

          return item
        })

      result.sort((a, b) => a.price > b.price ? 1 : (a.price === b.price ? 0 : -1))

      console.log('Filtering complete. Processing ', result.length, ' results...')
    } catch (err) {
      result = []
      console.error(err)
    }

    return result
  },
  findRealStateByName (name) {
    let list = db.get('real_state_list').value()

    return (list.filter(item => item.name === name) || []).shift() || false
  }
}

module.exports = Scrapper
