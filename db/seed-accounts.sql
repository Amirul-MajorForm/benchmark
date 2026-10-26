-- Meta account mapping (brief section 8). Existing rows are left alone so edits survive deploys.
insert into accounts (platform, account_id, name, client, market, account_type, currency) values
  ('meta', '764971328270854',  'OATSIDE',                        'Oatside', 'SG', 'Brand', 'SGD'),
  ('meta', '360540913050861',  'OATSIDE Indonesia',              'Oatside', 'ID', 'Brand', null),
  ('meta', '1197254745419550', 'OATSIDE Japan',                  'Oatside', 'JP', 'Brand', null),
  ('meta', '827231386048912',  'OATSIDE Korea',                  'Oatside', 'KR', 'Brand', null),
  ('meta', '480865091512259',  'OATSIDE Malaysia',               'Oatside', 'MY', 'Brand', null),
  ('meta', '1073423930376728', 'OATSIDE Philippines',            'Oatside', 'PH', 'Brand', null),
  ('meta', '754265510126878',  'OATSIDE Taiwan',                 'Oatside', 'TW', 'Brand', null),
  ('meta', '392347893765489',  'OATSIDE Thailand',               'Oatside', 'TH', 'Brand', null),
  ('meta', '2540917533074538', 'OATSIDE VN',                     'Oatside', 'VN', 'Brand', null),
  ('meta', '1925389034916546', 'OATSIDE_SG_CPAS_SHOPEE',         'Oatside', 'SG', 'CPAS',  null),
  ('meta', '674743694682068',  'OATSIDE_SG_CPAS_SHOPEE - DNU',   'Oatside', 'SG', 'CPAS',  null),
  ('meta', '335142002450041',  'OATSIDE_SG_CPAS_REDMART',        'Oatside', 'SG', 'CPAS',  null),
  ('meta', '1001057058029561', 'OATSIDE_MY_CPAS_SHOPEE',         'Oatside', 'MY', 'CPAS',  null),
  ('meta', '1437746287146983', 'OATSIDE_ID_CPAS_SHOPEE',         'Oatside', 'ID', 'CPAS',  null),
  ('meta', '343672155283730',  'OATSIDE_ID_CPAS_LAZADA',         'Oatside', 'ID', 'CPAS',  null),
  ('meta', '730983682111075',  'OATSIDE_ID_CPAS_TOKOPEDIA',      'Oatside', 'ID', 'CPAS',  null),
  ('meta', '271434125229951',  'OATSIDE_ID_CPAS_TOKOPEDIA',      'Oatside', 'ID', 'CPAS',  null),
  ('meta', '292204293382312',  'OATSIDE_ID_CPAS_TOKOPEDIA',      'Oatside', 'ID', 'CPAS',  null),
  ('meta', '1324603498206088', 'OATSIDE_PH_CPAS_SHOPEE',         'Oatside', 'PH', 'CPAS',  null),
  ('meta', '2011132199258393', 'OATSIDE_PH_CPAS_LAZADA',         'Oatside', 'PH', 'CPAS',  null),
  ('meta', '186600104319744',  'OATSIDE_TH_CPAS_LAZADA',         'Oatside', 'TH', 'CPAS',  null),
  ('meta', '742104760960709',  'OATSIDE_TH_CPAS_LAZADA',         'Oatside', 'TH', 'CPAS',  null),
  ('meta', '3517635831788796', 'OATSIDE_TH_CPAS_SHOPEE',         'Oatside', 'TH', 'CPAS',  null),
  ('meta', '1196047278954896', 'OATSIDE_VN_CPAS_SHOPEE',         'Oatside', 'VN', 'CPAS',  null),
  ('meta', '1696096351654353', 'BlueSG',                         'BlueSG', 'SG', 'Brand', null),
  ('meta', '1403655154777008', 'NOBO Malaysia',                  'NOBO', 'MY', 'Brand', null),
  ('meta', '926282839890420',  'NOBO Singapore',                 'NOBO', 'SG', 'Brand', null),
  ('meta', '177669546234251',  'Singapore Cat Festival',         'Singapore Cat Festival', 'SG', 'Brand', null),
  ('meta', '1560783511490229', 'STRONG Pilates Singapore',       'Strong Pilates', 'SG', 'Brand', null),
  ('meta', '1297936051774061', 'Strong Pilates Singapore (new)', 'Strong Pilates', 'SG', 'Brand', null),
  ('meta', '60873128',         'Yoga Movement Singapore',        'Yoga Movement', 'SG', 'Brand', null),
  ('meta', '666018586240602',  'Yoga Movement Hong Kong',        'Yoga Movement', 'HK', 'Brand', null)
on conflict (platform, account_id) do nothing;

-- Billing currencies known from the data (SGD spend / local spend on Sales rows). Fills blanks only.
-- The sync uses the non-SGD ones to check that Two Minutes really returned spend in SGD.
update accounts a set currency = v.currency
from (values
  ('1001057058029561', 'MYR'),
  ('1324603498206088', 'PHP'),
  ('1437746287146983', 'IDR'),
  ('764971328270854',  'SGD'),
  ('674743694682068',  'SGD'),
  ('186600104319744',  'SGD'),
  ('3517635831788796', 'SGD')
) as v(account_id, currency)
where a.platform = 'meta' and a.account_id = v.account_id and a.currency is null;
